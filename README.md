# obsnbsetup

Teaching notebooks on setting up Observable Notebook Kit, built with Notebook Kit itself.

- `nbks/` – source notebooks (`.html`), plus `custom.tmpl` and `copy-buttons.js`
- `dist/` – built site (`npm run build`)
- `tools/` – command-line helper (below)

```
npm run preview   # local preview
npm run build     # build into dist/
```

## Converting an online Observable notebook to the new `.html` format

Observable's host serves a bot challenge (HTTP 429) to non-browser requests, so no script or notebook cell can fetch a notebook page itself. The page has to be saved by a real browser first. Three ways. The converter page and the command line share the conversion code in `nbks/obs-export.mjs`; the bookmarklet is a separate, self-contained implementation of the same logic:

1. **Bookmarklet** (`nbks/downloadnb.js`): run on the notebook's page in the browser.
2. **Converter page** (`nbks/exportnb.html`, linked from `2_notebookkit.html`): save the notebook page from the browser (Save Page As → Web Page, HTML Only, or copy View Source), then drop the file onto the page, or paste the source. Conversion runs in the browser, so it works in `npm run preview`, on the published site, and needs no Node. In Chrome/Edge a **Save as…** button opens a save dialog; Firefox/Safari get an ordinary download link.
3. **Command line:** `node tools/obs-export.mjs saved-page.html -o nbks/` (output is a file or directory; the filename comes from the notebook title).

Only Notebooks 2.0 pages are supported. The tool reads the Next.js "flight data" (`self.__next_f.push(...)` chunks) embedded in the page, which is an internal format, not an API, and may change.

Notes from earlier experiments: Notebook Kit's Node cells run as `node --permission --allow-fs-read=.` in `nbks/`, so they can neither import code from outside `nbks/`, write files, nor are they suited to actions (output is cached and also runs on build). That is why no Node cell is used.

The converter page has been tested on a real saved notebook page (Chrome). The command-line version has only been tested on a synthetic page.
