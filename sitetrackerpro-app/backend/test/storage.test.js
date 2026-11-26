'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

// ---------------------------------------------------------------------------
// A failed upload has to say why. Render's free plan has no shell, so the browser
// message is the only diagnostic the deployer gets.
// ---------------------------------------------------------------------------
test('a rejected key names the keys, not "something went wrong"', () => {
  assert.match(describeStorageFailure({ name: 'InvalidAccessKeyId', code: 'InvalidAccessKeyId' }), /S3_ACCESS_KEY_ID/);
  assert.match(describeStorageFailure({ name: 'SignatureDoesNotMatch' }), /S3_SECRET_ACCESS_KEY/);
  assert.match(describeStorageFailure({ name: 'CredentialsProviderError' }), /rejected/);
});

test('bucket, region and endpoint problems are distinguishable', () => {
  assert.match(describeStorageFailure({ name: 'NoSuchBucket' }), /S3_BUCKET/);
  assert.match(describeStorageFailure({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), /bucket policy/);
  assert.match(describeStorageFailure({ name: 'PermanentRedirect' }), /S3_REGION/);
  assert.match(describeStorageFailure({ code: 'ETIMEDOUT' }), /S3_ENDPOINT/);
  assert.match(describeStorageFailure({ code: 'EAI_AGAIN' }), /S3_ENDPOINT/);
});

test('disk problems are named, and unknown errors stay quiet', () => {
  assert.match(describeStorageFailure({ code: 'ENOSPC' }), /disk space/);
  assert.match(describeStorageFailure({ code: 'EACCES' }), /upload folder/);
  assert.match(describeStorageFailure({ name: 'TooManyRequests', $metadata: { httpStatusCode: 503 } }), /server error/);
  assert.equal(describeStorageFailure({ name: 'TypeError', message: 'x is undefined' }), null);
  assert.equal(describeStorageFailure(null), null);
});

test('descriptions never echo a value from the error', () => {
  const message = describeStorageFailure({
    name: 'SignatureDoesNotMatch',
    message: 'key AKIAEXAMPLE was rejected for bucket private-bucket',
    $metadata: { httpStatusCode: 403 }
  });
  // The sentence names the variables to check; it never repeats the key or the bucket.
  assert.equal(/AKIAEXAMPLE|private-bucket/.test(message), false);
  assert.match(message, /S3_SECRET_ACCESS_KEY/);
});

const {
  DEFAULT_REGION,
  describeStorageFailure,
  normaliseS3Config,
  safeFileName,
  objectKey,
  createLocalStorage,
  createS3Storage,
  createStorage
} = require('../storage');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stp-storage-test-'));
}

/** A stand-in for the AWS SDK that records every command and can answer each one. */
function mockSdk({ onSend, signedUrl } = {}) {
  const sent = [];
  const clientOptions = [];

  class Command {
    constructor(input) {
      this.input = input;
      this.name = this.constructor.name;
    }
  }
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class HeadObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class DeleteObjectsCommand extends Command {}
  class ListObjectsV2Command extends Command {}

  class S3Client {
    constructor(options) {
      clientOptions.push(options);
    }
    async send(command) {
      sent.push(command);
      if (onSend) return onSend(command);
      return {};
    }
  }

  return {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    getSignedUrl: async (client, command, options) => (
      signedUrl ? signedUrl(command, options) : `https://signed.example/${command.input.Key}?expires=${options.expiresIn}`
    ),
    sent,
    clientOptions
  };
}

function s3Config(extra = {}) {
  return normaliseS3Config({
    S3_BUCKET: 'site-files',
    S3_ENDPOINT: 'https://project-ref.supabase.co/storage/v1/s3',
    S3_ACCESS_KEY_ID: 'access-key',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    ...extra
  });
}

function collector() {
  const chunks = [];
  const headers = {};
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  writable.setHeader = (name, value) => { headers[String(name).toLowerCase()] = value; };
  writable.headers = headers;
  writable.body = () => Buffer.concat(chunks).toString('utf8');
  return writable;
}

// ---------------------------------------------------------------------------
// Configuration and keys
// ---------------------------------------------------------------------------

test('S3 settings default the region and always use path-style addressing', () => {
  const config = normaliseS3Config({
    S3_BUCKET: 'site-files',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret'
  });

  assert.equal(config.region, DEFAULT_REGION);
  assert.equal(config.region, 'eu-central-1');
  assert.equal(config.forcePathStyle, true);
  assert.equal(config.enabled, true);
  assert.equal(config.usable, true);
  assert.equal(config.signedUrlTtlSeconds, 300);
});

test('a bucket without credentials is reported as unusable so uploads fall back', () => {
  const config = normaliseS3Config({ S3_BUCKET: 'site-files' });
  assert.equal(config.enabled, true);
  assert.equal(config.usable, false);
  assert.match(config.problems.join(' '), /S3_ACCESS_KEY_ID/);
  assert.match(config.problems.join(' '), /S3_SECRET_ACCESS_KEY/);
});

test('object keys follow projects/<id>/<category>/<uuid>-<filename> and cannot escape it', () => {
  const key = objectKey({ projectId: 42, category: 'models', filename: 'Bole Tower.ifc' });
  assert.match(key, /^projects\/42\/models\/[0-9a-f-]{36}-Bole-Tower\.ifc$/);

  const traversal = objectKey({ projectId: 42, category: 'models', filename: '../../etc/passwd' });
  assert.match(traversal, /^projects\/42\/models\/[0-9a-f-]{36}-passwd$/);
  assert.equal(traversal.includes('..'), false);

  assert.equal(safeFileName(''), 'file');
  assert.throws(() => objectKey({ projectId: 0, filename: 'a.tif' }), /positive project id/);
});

test('a configured S3 prefix is kept in front of the project path', () => {
  const storage = createS3Storage({ config: s3Config({ S3_PREFIX: 'uploads/' }), sdk: mockSdk() });
  const key = storage.objectKey({ projectId: 7, category: 'terrain', filename: 'dem.tif' });
  assert.match(key, /^uploads\/projects\/7\/terrain\/[0-9a-f-]{36}-dem\.tif$/);
});

// ---------------------------------------------------------------------------
// Zero-config local fallback
// ---------------------------------------------------------------------------

test('no S3_BUCKET keeps the uploads-volume behaviour with no SDK involvement', async () => {
  const root = tempDir();
  const storage = createStorage({ env: {}, rootDir: root });

  assert.equal(storage.driver, 'local-volume');
  assert.equal(storage.isRemote, false);

  const key = storage.objectKey({ projectId: 3, category: 'models', filename: 'tower.ifc' });
  const staged = path.join(root, 'staged.ifc');
  fs.writeFileSync(staged, 'IFC-CONTENT');

  await storage.putFromTemp(staged, key);
  assert.equal(await storage.readBuffer(key).then(buffer => buffer.toString()), 'IFC-CONTENT');
  assert.equal(await storage.size(key), 11);
  assert.deepEqual(Object.keys(await storage.materialise(key)), ['path', 'cleanup']);

  await storage.remove(key);
  await assert.rejects(storage.readBuffer(key), /ENOENT/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a half-configured bucket falls back to local storage instead of failing uploads', async () => {
  const root = tempDir();
  const storage = createStorage({ env: { S3_BUCKET: 'site-files' }, rootDir: root });
  assert.equal(storage.driver, 'local-volume');

  const key = storage.objectKey({ projectId: 1, category: 'models', filename: 'a.glb' });
  await storage.writeBuffer(Buffer.from('glb'), key);
  assert.equal(await storage.readBuffer(key).then(buffer => buffer.toString()), 'glb');

  // A local project delete removes the project folder.
  await storage.removeProject(1);
  await assert.rejects(storage.readBuffer(key), /ENOENT/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('local storage refuses keys that escape the uploads volume', () => {
  const root = tempDir();
  const storage = createLocalStorage({ rootDir: root });
  assert.throws(() => storage.absolute('../outside.txt'), /escapes the uploads volume/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// S3 upload, signed URL, stream download and delete
// ---------------------------------------------------------------------------

test('the S3 client is created with forcePathStyle, region and credentials', () => {
  const sdk = mockSdk();
  createS3Storage({ config: s3Config(), sdk });

  assert.equal(sdk.clientOptions.length, 1);
  assert.deepEqual(sdk.clientOptions[0], {
    region: 'eu-central-1',
    endpoint: 'https://project-ref.supabase.co/storage/v1/s3',
    forcePathStyle: true,
    // Checksums are opt-in: the SDK's default sends an `aws-chunked` body with a CRC32
    // trailer, which Supabase Storage and other S3-compatible services reject.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'access-key', secretAccessKey: 'secret-key' }
  });
});

test('an upload streams the staged file to the bucket and returns only the object key', async () => {
  const root = tempDir();
  const staged = path.join(root, 'upload.ifc');
  fs.writeFileSync(staged, 'ISO-10303-21;');

  let uploaded = null;
  const sdk = mockSdk({
    onSend: async (command) => {
      if (command.name === 'PutObjectCommand') {
        const chunks = [];
        for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
        uploaded = {
          body: Buffer.concat(chunks).toString('utf8'),
          bucket: command.input.Bucket,
          key: command.input.Key,
          contentType: command.input.ContentType,
          contentLength: command.input.ContentLength
        };
      }
      return {};
    }
  });

  const storage = createS3Storage({ config: s3Config(), sdk });
  const key = storage.objectKey({ projectId: 9, category: 'models', filename: 'tower.ifc' });
  const returned = await storage.putFromTemp(staged, key, { contentType: 'application/x-step' });

  assert.equal(returned, key);
  assert.match(key, /^projects\/9\/models\/[0-9a-f-]{36}-tower\.ifc$/);
  assert.deepEqual(uploaded, {
    body: 'ISO-10303-21;',
    bucket: 'site-files',
    key,
    contentType: 'application/x-step',
    contentLength: 13
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('generated buffers are uploaded with their own length', async () => {
  let put = null;
  const sdk = mockSdk({
    onSend: command => {
      if (command.name === 'PutObjectCommand') put = command.input;
      return {};
    }
  });
  const storage = createS3Storage({ config: s3Config(), sdk });

  await storage.writeBuffer(Buffer.from([1, 2, 3, 4]), 'projects/2/terrain/preview.f32');
  assert.equal(put.Bucket, 'site-files');
  assert.equal(put.Key, 'projects/2/terrain/preview.f32');
  assert.equal(put.ContentLength, 4);
  assert.deepEqual([...put.Body], [1, 2, 3, 4]);
});

test('a signed GET URL is short-lived and aimed at the stored key', async () => {
  const sdk = mockSdk();
  const storage = createS3Storage({ config: s3Config(), sdk });
  const key = 'projects/4/models/model.glb';

  const url = await storage.signedUrl(key, { expiresIn: 120, filename: 'model.glb', contentType: 'model/gltf-binary' });
  assert.equal(url, `https://signed.example/${key}?expires=120`);

  // Values outside 30-3600 seconds fall back to the configured default rather than creating a
  // URL that never expires.
  const capped = await storage.signedUrl(key, { expiresIn: 999999 });
  assert.match(capped, /expires=300$/);
});

test('remote files are streamed through the API with the right headers', async () => {
  const body = Buffer.from('glTF-binary-bytes');
  const sdk = mockSdk({
    onSend: command => {
      if (command.name === 'GetObjectCommand') {
        return { Body: Readable.from([body]), ContentLength: body.length, ContentType: 'model/gltf-binary' };
      }
      return {};
    }
  });
  const storage = createS3Storage({ config: s3Config(), sdk });
  const res = collector();

  await storage.pipeTo(res, 'projects/4/models/model.glb', {
    contentType: 'model/gltf-binary',
    filename: 'model.glb',
    cacheControl: 'private, max-age=300'
  });

  assert.equal(res.body(), 'glTF-binary-bytes');
  assert.equal(res.headers['content-type'], 'model/gltf-binary');
  assert.equal(String(res.headers['content-length']), String(body.length));
  assert.equal(res.headers['content-disposition'], 'inline; filename="model.glb"');
  assert.equal(res.headers['cache-control'], 'private, max-age=300');
});

test('deleting a model removes exactly its object', async () => {
  const sdk = mockSdk();
  const storage = createS3Storage({ config: s3Config(), sdk });

  await storage.remove('projects/4/models/model.glb');
  const deletes = sdk.sent.filter(command => command.name === 'DeleteObjectCommand');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].input, { Bucket: 'site-files', Key: 'projects/4/models/model.glb' });
});

test('deleting a project sweeps every object under its prefix', async () => {
  const pages = [
    { Contents: [{ Key: 'projects/8/models/a.glb' }, { Key: 'projects/8/terrain/b.tif' }], IsTruncated: true, NextContinuationToken: 'next' },
    { Contents: [{ Key: 'projects/8/terrain/b.tif.preview.f32' }], IsTruncated: false }
  ];
  const sdk = mockSdk({
    onSend: command => {
      if (command.name === 'ListObjectsV2Command') return pages.shift();
      return {};
    }
  });
  const storage = createS3Storage({ config: s3Config({ S3_PREFIX: 'uploads' }), sdk });

  const removed = await storage.removeProject(8);
  assert.equal(removed, 3);

  const lists = sdk.sent.filter(command => command.name === 'ListObjectsV2Command');
  assert.equal(lists[0].input.Prefix, 'uploads/projects/8/');
  assert.equal(lists[1].input.ContinuationToken, 'next');

  const deletes = sdk.sent.filter(command => command.name === 'DeleteObjectsCommand');
  assert.deepEqual(deletes[0].input.Delete.Objects, [
    { Key: 'projects/8/models/a.glb' },
    { Key: 'projects/8/terrain/b.tif' }
  ]);
});

test('a missing remote object is reported as not found rather than crashing the route', async () => {
  const sdk = mockSdk({
    onSend: command => {
      if (command.name === 'GetObjectCommand') {
        const err = new Error('The specified key does not exist.');
        err.name = 'NoSuchKey';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    }
  });
  const storage = createS3Storage({ config: s3Config(), sdk });

  await assert.rejects(
    storage.pipeTo(collector(), 'projects/1/models/missing.glb'),
    err => err.notFound === true
  );
});

test('a remote GeoTIFF can be materialised for readers that need a real file', async () => {
  const sdk = mockSdk({
    onSend: command => {
      if (command.name === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('II*\u0000tiff')]) };
      return {};
    }
  });
  const storage = createS3Storage({ config: s3Config(), sdk });

  const copy = await storage.materialise('projects/2/terrain/dem.tif');
  assert.equal(fs.readFileSync(copy.path, 'utf8'), 'II*\u0000tiff');
  await copy.cleanup();
  assert.equal(fs.existsSync(copy.path), false);
});

// ---------------------------------------------------------------------------
// The /health self-test: does the bucket accept these keys?
// ---------------------------------------------------------------------------

test('the storage self-test lists one key and never writes', async () => {
  const sdk = mockSdk();
  const storage = createS3Storage({ config: s3Config(), sdk });

  const result = await storage.checkAccess();
  assert.equal(typeof result.latencyMs, 'number');

  assert.equal(sdk.sent.length, 1);
  assert.equal(sdk.sent[0].name, 'ListObjectsV2Command');
  assert.equal(sdk.sent[0].input.Bucket, 'site-files');
  assert.equal(sdk.sent[0].input.MaxKeys, 1);
});

test('a rejected key comes back as the sentence naming the variable to fix', async () => {
  const sdk = mockSdk({
    onSend: () => {
      const err = new Error('The request signature we calculated does not match the signature you provided.');
      err.name = 'SignatureDoesNotMatch';
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    }
  });
  const storage = createS3Storage({ config: s3Config(), sdk });

  const failure = await storage.checkAccess().then(() => null, err => err);
  assert.ok(failure, 'the check must fail rather than report a healthy bucket');

  const reason = describeStorageFailure(failure);
  assert.match(reason, /S3_SECRET_ACCESS_KEY/);
  assert.equal(/secret-key|access-key/.test(reason), false);
});

test('a bucket that never answers is reported as a timeout, not left hanging', async () => {
  const sdk = mockSdk({ onSend: () => new Promise(() => {}) });
  const storage = createS3Storage({ config: s3Config(), sdk });

  const failure = await storage.checkAccess({ timeoutMs: 20 }).then(() => null, err => err);
  assert.ok(failure);
  assert.equal(failure.code, 'ETIMEDOUT');
  assert.match(describeStorageFailure(failure), /S3_ENDPOINT/);
});
