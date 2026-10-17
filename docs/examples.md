# Documentation website and publication

The public website includes an overview, installation, guides, API reference and
nineteen tutorials with live maps. Tutorials cover first maps, editable points,
lines/polygon holes, bindings, GeoJSON, route elevation, labels/image pins,
markers with tooltips, popups and dragging, pin clustering, the gesture guard
and fullscreen plugins, raster tiles and plugins, plus four real-world recipes:
a city guide, vehicle tracking, a filterable site explorer and a measuring tool.
Diagnostic pages, benchmarks and server-dependent fixtures remain in `demo/`.

## Local preview

```bash
npm ci --ignore-scripts
npm run examples:build
npm run examples:serve
```

Open <http://localhost:8401/>. The generated site is in `.example-build/site/`.
Each tutorial combines explanatory prose, a map, controls, renderer selection,
complete source and links to the relevant guides and reference. WebGL 1 is the default; WebGPU can fall back
to WebGL 1. Unsupported GPU initialization is reported in the example's status.

Most examples do not download basemaps by default. The raster tutorial requests
OpenStreetMap only after its button is selected; the real-world recipes load
OpenStreetMap tiles directly because a real basemap is their subject. They all
carry the source attribution, request tiles only for the visible view, and never
prefetch or cache tiles; the city guide can switch to inline demo tiles for
offline work. GeoJSON input is local to the browser and bounded to 64 KiB /
100 points. The website is static HTML; maps load only on the tutorial pages,
not on overview, guide or reference pages.

## GitHub Pages

In **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
The `Publish documentation` workflow runs on pushes to `main` and can be run manually
from the Actions tab. It checks the project, builds the library and examples,
then uploads and deploys only the generated public site. No npm package version
change is needed to update documentation. Package releases keep their separate
workflow.

The default project URL is <https://fir3st.github.io/maplet/>. The workflow uses
the actual Pages base URL from `configure-pages`, including a custom domain if
configured, for standalone Gist imports and live-example links. The site itself
uses relative links and runs under a project subdirectory.

## Public source Gists

**Gist does not host executable HTML.** Pages hosts the live examples; Gists
contain their source files. There is one public Gist per example and one public
Markdown index linking to the live collection and individual source Gists.

GitHub's built-in repository workflow authentication cannot write Gists. The
account owner must separately configure this in GitHub's UI:

1. Create a classic personal access authorization with only the **`gist`** scope
   for the `Fir3st` account. Choose an expiration and rotate it in GitHub as needed.
2. Store it as the repository Actions secret **`GIST_PUBLISH_PAT`**.
3. Create the repository Actions variable **`GISTS_ENABLED`** with value `true`.
4. Run **Publish documentation** from the Actions tab, or push to `main`.

Do not commit authorization material, create local auth files or paste values
into source code, chat or logs. The publisher delegates authentication to `gh`
inside the runner; it does not inspect authentication files. This setup must be
performed by the account owner, not by the coding agent.

Without `GISTS_ENABLED=true`, Pages can deploy independently and displays
“Gist not published yet” instead of broken or fabricated source links. When
enabled, missing/expired authorization or GitHub API errors fail the workflow;
they do not silently claim success. The authorization's account must match the
repository owner.

The publisher discovers **public Gist metadata only**, using descriptions
beginning with `Maplet examples [Fir3st/maplet]`. It creates missing Gists,
updates changed files in place and skips unchanged ones by content hash. No
unrelated Gist contents are read or changed, and no Gist is deleted. Duplicate managed
descriptions are an error. Partial runs can be retried: already-created URLs
are rediscovered, so retries do not create another set of Gists.

Each example Gist contains `index.html`, `example.js`, `shared.js`, `style.css`,
`README.md`, `LICENSE` and `NOTICE`. Download them into one directory and serve
them over HTTP to run a copy. The shared setup imports the built library from
the configured Pages URL, including its worker-relative module graph. Thus the
downloaded example requires that Pages deployment and an internet connection;
the compiled library is not misleadingly presented as a self-contained Gist.
Browser cross-origin worker restrictions can select the library's supported
inline import fallback when running a downloaded copy.

Generated Gists follow the current website, not immutable package releases.
Edit `examples/` in the repository; the publisher owns the generated Gist files.
Stable Gist URLs and the index URL are saved in the deployed `gists.json` and
linked from tutorial source panels. Turning Gist publication off builds
a fresh site without Gist links; it does not delete previously published Gists.

## Maintaining documentation

- `examples/catalog.json` is the single source for titles, groups, descriptions,
  source provenance and navigation.
- `docs/*.md` and `docs/tutorials/*.md` supply readable guides and tutorial prose.
  The live-example marker places a map and its source inside a tutorial.
- `examples/*.js` implement the actual examples; `shared.js` owns common page
  setup, map lifecycle, error reporting and toolbar behavior.
- `scripts/docs-site.mjs` renders authored Markdown and the shared document shell.
  It generates reference tables from built public declarations, including inherited
  members, overloads and all three package entry points.
- `scripts/build-examples.mjs` builds the documentation site, embeds live tutorials
  and assembles allowlisted standalone Gist payloads. Existing `/examples/<id>/`
  URLs remain valid.
- `scripts/publish-gists.mjs` owns discovery and idempotent Gist publication.
- Gist payloads are bounded to 1.25 MiB total and 128 KiB per example. Discovery is
  limited to 2,000 public Gists and fails before any writes if it cannot finish.
  Writes are sequential and limited to one per changed example plus its index.

Unit tests use fake GitHub responses; they never publish or inspect live Gists.
Website tests check every local document/asset link and fragment, unique anchors,
critical inherited API members, Markdown escaping and standalone-file budgets.
Real publication is established only by a successful authorized workflow and
the resulting Pages/Gist URLs, not by those tests alone.
