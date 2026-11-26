'use strict';
/**
 * Object storage for uploaded binaries.
 *
 * Every upload that is kept (BIM models, DEM GeoTIFFs, generated previews) goes through this
 * module, so only one place knows where bytes live. When S3_BUCKET is configured the object
 * store is S3-compatible (Supabase Storage, AWS, R2, MinIO); when it is not, files stay on the
 * local uploads volume exactly as before. Local development and the test suite therefore need
 * no cloud credentials.
 *
 * The database stores the object key only (e.g. projects/7/models/<uuid>-tower.ifc). Local
 * storage resolves that key under the uploads volume; S3 storage resolves it in the bucket.
 * Rows written before object storage existed hold an absolute path, which callers can still
 * recognise with path.isAbsolute().
 *
 * Delivery: remote objects are never exposed as public URLs. Routes stream them through the
 * authenticated API (pipeTo), which keeps MapLibre/Three.js fetches same-origin and free of
 * bucket CORS rules, and signedUrl() is available when a short-lived direct URL is preferred.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REGION = 'eu-central-1';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MIN_SIGNED_URL_TTL_SECONDS = 30;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
const MAX_FILE_NAME_LENGTH = 120;

const text = value => (typeof value === 'string' ? value.trim() : '');

function normalisePrefix(value) {
  return text(value).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function normaliseTtl(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_SIGNED_URL_TTL_SECONDS || seconds > MAX_SIGNED_URL_TTL_SECONDS) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }
  return Math.round(seconds);
}

/**
 * Reads the S3 settings from the environment.
 *
 * `forcePathStyle` is always true: Supabase Storage (and MinIO and most other S3-compatible
 * endpoints) only answer path-style requests, never virtual-hosted bucket subdomains.
 *
 * `enabled` is whether a bucket is configured at all; `usable` is whether the credentials are
 * present too. A bucket without credentials is reported and the caller falls back to local
 * storage rather than failing every upload at runtime.
 */
function normaliseS3Config(env = process.env) {
  const bucket = text(env.S3_BUCKET);
  const region = text(env.S3_REGION) || DEFAULT_REGION;
  const endpoint = text(env.S3_ENDPOINT) || '';
  const accessKeyId = text(env.S3_ACCESS_KEY_ID);
  const secretAccessKey = text(env.S3_SECRET_ACCESS_KEY);
  const prefix = normalisePrefix(env.S3_PREFIX);

  const problems = [];
  if (bucket && !accessKeyId) problems.push('S3_ACCESS_KEY_ID is not set.');
  if (bucket && !secretAccessKey) problems.push('S3_SECRET_ACCESS_KEY is not set.');

  return {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    prefix,
    forcePathStyle: true,
    signedUrlTtlSeconds: normaliseTtl(env.S3_SIGNED_URL_TTL_SECONDS),
    enabled: Boolean(bucket),
    usable: Boolean(bucket) && problems.length === 0,
    problems
  };
}

/** A filename that is safe in an object key and still recognisable to the user. */
function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(-MAX_FILE_NAME_LENGTH) || 'file';
}

/** projects/<projectId>/<category>/<uuid>-<filename> */
function objectKey({ projectId, category = 'files', filename = 'file', prefix = '' } = {}) {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('A positive project id is required to build a storage key.');
  }
  const folder = String(category || 'files')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'files';
  return [prefix, 'projects', id, folder, `${crypto.randomUUID()}-${safeFileName(filename)}`]
    .filter(Boolean)
    .join('/');
}

function isStorageNotFound(err) {
  if (!err) return false;
  if (err.notFound === true) return true;
  if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.name === 'NoSuchBucket') return true;
  return Boolean(err.$metadata && err.$metadata.httpStatusCode === 404);
}

function markNotFound(err) {
  if (isStorageNotFound(err)) {
    err.notFound = true;
    return err;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Local uploads volume (the zero-config fallback)
// ---------------------------------------------------------------------------

function createLocalStorage({ rootDir, prefix = '' } = {}) {
  if (!rootDir) throw new Error('Local storage needs a root directory.');
  const root = path.resolve(rootDir);

  const absolute = key => {
    const resolved = path.resolve(root, String(key));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('Storage key escapes the uploads volume.');
    }
    return resolved;
  };

  return {
    driver: 'local-volume',
    isRemote: false,
    root,
    describe: () => `local uploads volume (${root})`,

    objectKey: options => objectKey({ ...options, prefix }),

    absolute,
    // Local files are already on disk, so no copy is needed.
    localPath: key => absolute(key),

    async putFromTemp(tempPath, key) {
      const destination = absolute(key);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.promises.rename(tempPath, destination);
      } catch (err) {
        // A different volume (a /tmp in another container layer) cannot be renamed across;
        // copy instead, then drop the staged file.
        if (err.code !== 'EXDEV') throw err;
        await fs.promises.copyFile(tempPath, destination);
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      return key;
    },

    async writeBuffer(buffer, key) {
      const destination = absolute(key);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, buffer);
      return key;
    },

    async readBuffer(key) {
      return fs.promises.readFile(absolute(key));
    },

    async createReadStream(key) {
      return fs.createReadStream(absolute(key));
    },

    async size(key) {
      return (await fs.promises.stat(absolute(key))).size;
    },

    async sha256(key) {
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(absolute(key))
          .on('data', chunk => hash.update(chunk))
          .on('end', () => resolve(hash.digest('hex')))
          .on('error', reject);
      });
    },

    async remove(key) {
      try {
        await fs.promises.unlink(absolute(key));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return true;
    },

    /** Everything that belongs to one project, removed in one go. */
    async removeProject(projectId) {
      const id = Number(projectId);
      if (!Number.isInteger(id) || id <= 0) return 0;

      const countFiles = async dir => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => null);
        if (!entries) return 0;
        let total = 0;
        for (const entry of entries) {
          total += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
        }
        return total;
      };

      let removed = 0;
      for (const relative of [`projects/${id}`, `terrain/${id}`]) {
        const target = absolute(relative);
        try {
          removed += await countFiles(target);
          await fs.promises.rm(target, { recursive: true, force: true });
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      return removed;
    },

    /** Local files need no temporary copy; cleanup is a no-op. */
    async materialise(key) {
      return { path: absolute(key), cleanup: async () => {} };
    },

    /** Direct signed URLs are an object-store feature; local files use the proxy stream. */
    async signedUrl() {
      return null;
    },

    async pipeTo(res, key, { contentType, filename, cacheControl } = {}) {
      const file = absolute(key);
      let stats;
      try {
        stats = await fs.promises.stat(file);
      } catch (err) {
        if (err.code === 'ENOENT') {
          const missing = new Error('The stored file is no longer on disk.');
          missing.notFound = true;
          throw missing;
        }
        throw err;
      }
      if (!stats.isFile()) {
        const missing = new Error('The stored path is not a file.');
        missing.notFound = true;
        throw missing;
      }

      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.setHeader('Content-Length', stats.size);
      if (filename) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);

      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.once('error', err => {
          res.destroy(err);
          reject(err);
        });
        res.once('finish', resolve);
        res.once('close', resolve);
        stream.pipe(res);
      });
      return true;
    }
  };
}

// ---------------------------------------------------------------------------
// S3-compatible object storage
// ---------------------------------------------------------------------------

function loadS3Sdk() {
  try {
    const core = require('@aws-sdk/client-s3');
    const presigner = require('@aws-sdk/s3-request-presigner');
    return {
      S3Client: core.S3Client,
      PutObjectCommand: core.PutObjectCommand,
      GetObjectCommand: core.GetObjectCommand,
      HeadObjectCommand: core.HeadObjectCommand,
      DeleteObjectCommand: core.DeleteObjectCommand,
      DeleteObjectsCommand: core.DeleteObjectsCommand,
      ListObjectsV2Command: core.ListObjectsV2Command,
      getSignedUrl: presigner.getSignedUrl
    };
  } catch (err) {
    throw new Error(
      'S3 storage requires @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner. ' +
      'Install them with: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
    );
  }
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createS3Storage({ config, sdk, client } = {}) {
  if (!config || !config.bucket) throw new Error('S3 storage needs a bucket.');
  const aws = sdk || loadS3Sdk();
  const s3 = client || new aws.S3Client({
    region: config.region,
    // Left undefined for real AWS so the default endpoint is used.
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle !== false,
    // AWS SDK 3.729+ computes a CRC32 checksum by default and sends the body as `aws-chunked`
    // with a trailer. Supabase Storage and several other S3-compatible services reject that
    // framing, so checksums are only calculated when an operation requires one. An upload is
    // then a plain PUT with Content-Length, which every S3-compatible endpoint accepts.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  const send = command => s3.send(command);

  /**
   * Sends one command with a deadline. A hung endpoint must fail with ETIMEDOUT (so
   * describeStorageFailure can name S3_ENDPOINT), and the abandoned request must not
   * surface later as an unhandled rejection.
   */
  function sendWithin(command, timeoutMs) {
    const controller = new AbortController();
    const request = s3.send(command, { abortSignal: controller.signal });
    request.catch(() => {});

    let timer;
    const timedOut = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const timeout = new Error('The bucket did not answer in time.');
        timeout.code = 'ETIMEDOUT';
        reject(timeout);
      }, timeoutMs);
    });
    return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
  }

  return {
    driver: 's3',
    isRemote: true,
    bucket: config.bucket,
    region: config.region,
    describe: () => `S3-compatible object storage (bucket ${config.bucket}, region ${config.region}` +
      `${config.endpoint ? `, endpoint ${config.endpoint}` : ''})`,

    objectKey: options => objectKey({ ...options, prefix: config.prefix }),

    // No local path for a remote object.
    localPath: () => null,

    async putFromTemp(tempPath, key, { contentType } = {}) {
      const stats = await fs.promises.stat(tempPath);
      await send(new aws.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: fs.createReadStream(tempPath),
        ContentLength: stats.size,
        ...(contentType ? { ContentType: contentType } : {})
      }));
      return key;
    },

    async writeBuffer(buffer, key, { contentType } = {}) {
      await send(new aws.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: buffer,
        ContentLength: buffer.length,
        ...(contentType ? { ContentType: contentType } : {})
      }));
      return key;
    },

    async readBuffer(key) {
      const response = await send(new aws.GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return bodyToBuffer(response && response.Body);
    },

    async createReadStream(key) {
      const response = await send(new aws.GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return response.Body;
    },

    async size(key) {
      const response = await send(new aws.HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return Number(response.ContentLength);
    },

    /**
     * Proves the credentials reach the bucket without changing anything: listing a single key is
     * the cheapest call that both authenticates the signed request and names the bucket. /health
     * uses it so an operator can tell a working key from a rejected one without a real upload.
     * Nothing from the listing is returned or logged.
     */
    async checkAccess({ timeoutMs = 5000 } = {}) {
      const startedAt = Date.now();
      await sendWithin(new aws.ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }), timeoutMs);
      return { latencyMs: Date.now() - startedAt };
    },

    /**
     * Proves the credentials can actually store an object, which is what an upload needs and a
     * listing does not test: a read-only key lists the bucket happily and then fails the first
     * BIM upload. The probe writes one small fixed object and deletes it again, so it never
     * leaves anything behind and cannot fill the bucket.
     */
    async checkWrite({ timeoutMs = 5000 } = {}) {
      const startedAt = Date.now();
      const key = [config.prefix, '_health', 'write-check.txt'].filter(Boolean).join('/');
      const body = Buffer.from('sitetrackerpro storage write check');

      await sendWithin(new aws.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: 'text/plain'
      }), timeoutMs);

      // A probe that could be stored but not removed is still a working bucket for uploads;
      // the leftover object is tiny and the same key is overwritten next time.
      let removed = true;
      try {
        await sendWithin(new aws.DeleteObjectCommand({ Bucket: config.bucket, Key: key }), timeoutMs);
      } catch (err) {
        removed = false;
      }
      return { latencyMs: Date.now() - startedAt, removed };
    },

    async sha256(key) {
      const stream = await this.createReadStream(key);
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
      });
    },

    async remove(key) {
      try {
        await send(new aws.DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (err) {
        // Deleting a missing object is not an error: the caller wanted it gone.
        if (!isStorageNotFound(err)) throw err;
      }
      return true;
    },

    /** Removes every object under the project's prefix, 1,000 keys per request. */
    async removeProject(projectId) {
      const id = Number(projectId);
      if (!Number.isInteger(id) || id <= 0) return 0;
      const base = config.prefix ? `${config.prefix}/` : '';
      const projectPrefix = `${base}projects/${id}/`;
      let token;
      let removed = 0;

      do {
        const page = await send(new aws.ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: projectPrefix,
          ContinuationToken: token
        }));
        const keys = ((page && page.Contents) || []).map(item => item.Key).filter(Boolean);
        if (keys.length > 0) {
          await send(new aws.DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true }
          }));
          removed += keys.length;
        }
        token = page && page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);

      return removed;
    },

    /** Downloads an object once for code that needs a real file (GeoTIFF readers). */
    async materialise(key) {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stp-storage-'));
      const target = path.join(tempDir, safeFileName(path.basename(String(key))));
      const stream = await this.createReadStream(key);
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(target);
        stream.once('error', reject);
        output.once('error', reject);
        output.once('finish', resolve);
        stream.pipe(output);
      });
      return {
        path: target,
        cleanup: async () => {
          await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      };
    },

    async signedUrl(key, { expiresIn = config.signedUrlTtlSeconds, contentType, filename } = {}) {
      const command = new aws.GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ...(contentType ? { ResponseContentType: contentType } : {}),
        ...(filename ? { ResponseContentDisposition: `inline; filename="${encodeURIComponent(filename)}"` } : {})
      });
      return aws.getSignedUrl(s3, command, { expiresIn: normaliseTtl(expiresIn) });
    },

    async pipeTo(res, key, { contentType, filename, cacheControl } = {}) {
      let response;
      try {
        response = await send(new aws.GetObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (err) {
        throw markNotFound(err);
      }

      res.setHeader('Content-Type', contentType || (response && response.ContentType) || 'application/octet-stream');
      if (response && response.ContentLength !== undefined && response.ContentLength !== null) {
        res.setHeader('Content-Length', response.ContentLength);
      }
      if (filename) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);

      const body = response && response.Body;
      if (!body) {
        res.end();
        return true;
      }

      await new Promise((resolve, reject) => {
        body.once('error', err => {
          res.destroy(err);
          reject(err);
        });
        res.once('finish', resolve);
        res.once('close', resolve);
        body.pipe(res);
      });
      return true;
    }
  };
}

/**
 * The storage used by the running app: S3 when S3_BUCKET (and credentials) are set, the local
 * uploads volume otherwise. A half-configured bucket warns and falls back instead of turning
 * every upload into an error.
 */
function createStorage({ env = process.env, rootDir, sdk, client } = {}) {
  const config = normaliseS3Config(env);
  if (config.usable) {
    return createS3Storage({ config, sdk, client });
  }

  const local = createLocalStorage({ rootDir });
  if (config.enabled) {
    console.warn(
      '⚠️ S3_BUCKET is set but object storage is not usable: ' + config.problems.join(' ') +
      ' Falling back to local uploads in ' + local.root
    );
  }
  return local;
}

/**
 * Turns a storage failure into one sentence an administrator can act on.
 *
 * Uploads used to answer "something went wrong", which is useless from the other side of a
 * browser: the reason (rejected keys, wrong bucket, unreachable endpoint) was only in the
 * server log, and on a host without a shell that log is all the deployer has. This names the
 * cause without echoing anything secret: no keys, no URLs, no bucket contents.
 */
function describeStorageFailure(err) {
  if (!err) return null;

  const code = String(err.code || err.Code || err.name || '');
  const status = err.$metadata ? err.$metadata.httpStatusCode : null;

  if (/InvalidAccessKeyId|SignatureDoesNotMatch|CredentialsProviderError|InvalidToken|UnrecognizedClientException/i.test(code)) {
    return 'the storage keys were rejected — check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY';
  }
  if (/NoSuchBucket/i.test(code)) {
    return 'the bucket does not exist — check S3_BUCKET';
  }
  if (/AccessDenied/i.test(code) || status === 403) {
    return 'those keys may read but not write to this bucket — check the bucket policy in Supabase';
  }
  if (/PermanentRedirect|AuthorizationHeaderMalformed|IllegalLocationConstraint/i.test(code)) {
    return 'the bucket is in a different region — check S3_REGION';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EPIPE/i.test(code)) {
    return 'the storage endpoint could not be reached — check S3_ENDPOINT';
  }
  if (/ENOSPC/i.test(code)) {
    return 'the server ran out of disk space while preparing the file';
  }
  if (/EACCES|EPERM|EROFS/i.test(code)) {
    return 'the server cannot write to its upload folder';
  }
  if (/ENOENT/i.test(code)) {
    return 'the staged upload disappeared before it could be stored';
  }
  if (typeof status === 'number' && status >= 500) {
    return 'the storage service itself reported a server error — try again in a minute';
  }
  return null;
}

module.exports = {
  DEFAULT_REGION,
  describeStorageFailure,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  normaliseS3Config,
  safeFileName,
  objectKey,
  isStorageNotFound,
  createLocalStorage,
  createS3Storage,
  createStorage
};
