# Riptide Worker: moved

The Worker that powers this dashboard now lives in its own open-source repo:
**https://github.com/benjiprojects1404-maker/riptide** (`worker/`).

That repo is the only copy of the code. The live Worker (`riptide.benjiprojects1404.workers.dev`) is deployed
from it, with the same Worker name and D1 database, so the data and secrets carry over.

This folder (`riptide/`) keeps only the live dashboard pages served on this site.
