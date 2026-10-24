# Flight Select

Windows desktop application for reviewing geotagged drone photographs, identifying spatial/time-separated matches, and copying the chosen images to a new folder.

## Run during development

```powershell
npm.cmd install
npm.cmd start
```

## Build Windows deliverables

```powershell
npm.cmd run build:win
```

The generated files are placed in `release/`:

- `Flight Select Setup <version>.exe` — Windows installer.
- `Flight Select <version>.exe` — portable executable, when the portable target completes.

The desktop app uses native Windows dialogs to select multiple survey folders and choose the output folder for copied JPGs. It processes image data locally.
