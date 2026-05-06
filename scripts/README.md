# Hub scripts

## release-plexus.ps1

Sync the Plexus tool source from this hub to the standalone
[plexus repo](https://github.com/nicolasiven-ops/plexus) and push.
Vercel auto-deploys the plexus repo on every push to `main`.

### Usage

From the hub root:

```powershell
pwsh ./scripts/release-plexus.ps1
```

With version label and custom message:

```powershell
pwsh ./scripts/release-plexus.ps1 -Version "v1.0.1" -Message "fix: LAG-pair render glitch"
```

### What it syncs

Copies these files from hub root into `plexus/lib/`:

- `module-runtime.js`
- `mod_002_netmap.js`
- `mod_002_netmap.css`
- `mod_002_persistence.js`
- `mod_002_radial.js`
- `mod_002_utils.js`

Plus `favicon.svg` to `plexus/favicon.svg`.

### What it does NOT sync

The standalone wrappers in the plexus repo are maintained separately:

- `index.html` (landing)
- `styles.css`
- `app/index.html` (demo + license modal)
- `app/demo.css`

Edit those directly in the plexus repo if they need changes.

### Prerequisites

The plexus repo must be cloned alongside this hub:

```
C:\...\300 - Websites\MyHome\        <- this hub
C:\...\300 - Websites\plexus\        <- standalone plexus repo
```

If missing:

```bash
cd "C:/Users/nicol/OneDrive/300 - Websites/"
git clone https://github.com/nicolasiven-ops/plexus.git
```
