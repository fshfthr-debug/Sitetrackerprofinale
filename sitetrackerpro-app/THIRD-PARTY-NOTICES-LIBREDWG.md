# Third-party notice — GNU LibreDWG (`dwg2dxf`)

SiteTrackerPro can import native AutoCAD `.dwg` drawings. Conversion to DXF is performed by
**GNU LibreDWG**, which is licensed under the **GNU General Public License, version 3 or later
(GPL-3.0-or-later)**.

## How it is used

LibreDWG is **not** linked into SiteTrackerPro, imported as a library, or compiled into the
JavaScript bundle. It is installed in the application image as the standalone command-line
program `dwg2dxf` and run as a **separate process** by the API:

```
POST /api/cad/convert   →   spawn("dwg2dxf", [input.dwg, "-y", "-o", output.dxf])
```

The two programs exchange a file name and two files on disk. That keeps LibreDWG a separate
work under its own licence, and SiteTrackerPro's own source code under its own terms.

Every call is bounded before it reaches the converter: a 20 MB input cap, a wall-clock timeout
(`DWG_TIMEOUT_MS`, default 30 s) that kills the child process, a hard address-space limit
(`DWG_MEMORY_LIMIT_KB`, default 768 MB), an 80 MB output cap, a per-call scratch directory, and
no shell (arguments are passed as an array, never as a command string).

## Version used

- Upstream: https://ftp.gnu.org/gnu/libredwg/
- Pinned in the `Dockerfile`: `LIBREDWG_VERSION=0.13.3` (`ARG LIBREDWG_VERSION`)
- Build flags: `--disable-bindings --disable-python --disable-docs`

## Source offer (GPL-3.0 §6)

The Corresponding Source for the LibreDWG version in this image is the unmodified upstream
release archive:

- **https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz**
- Project home and repository: https://www.gnu.org/software/libredwg/
- Mirror: https://github.com/LibreDWG/libredwg

SiteTrackerPro applies **no patches** to LibreDWG. If that ever changes, the patch set must be
published at a stable URL and listed here before the image is shipped.

To rebuild the exact artefact from source:

```
docker build --target libredwg -t libredwg-check .
docker run --rm libredwg-check /usr/local/bin/dwg2dxf --version
```

If you received the image or a hosted service built from it and cannot fetch the archive above,
request a copy of the source from the operator of the deployment; GPL-3.0 requires them to
provide it.

## Licence text

The full GPL-3.0 text is available at https://www.gnu.org/licenses/gpl-3.0.txt and is included
with the LibreDWG source archive. LibreDWG is Copyright © the GNU LibreDWG authors.

## Disabling DWG

DWG import is optional. Remove the two `COPY --from=libredwg` lines from the `Dockerfile` (or set
`DWG2DXF_PATH` to a path that does not exist) and the API reports
`GET /api/cad/status → { "enabled": false }`; `.dwg` uploads then return a clear instruction to
export DXF instead. DXF import, DXF export, KML and Shapefile are unaffected — they are original
pure-JavaScript code with no third-party licence obligations.
