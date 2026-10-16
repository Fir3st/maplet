# Download and installation

Maplet is published as **@fir3st/maplet** to GitHub Packages, not npmjs.com.
Release archives are available without registry authentication.

## Release archive

Download `fir3st-maplet-0.1.0-alpha.11.tgz` from
[GitHub Releases](https://github.com/Fir3st/maplet/releases/tag/v0.1.0-alpha.11), then run:

```sh
npm install ./fir3st-maplet-0.1.0-alpha.11.tgz
```

Import the package from your application:

```ts
import { createMap } from '@fir3st/maplet';
```

## GitHub Packages

With GitHub package-read authentication already configured:

```sh
npm install @fir3st/maplet@next --registry=https://npm.pkg.github.com
```

The GitHub npm registry requires authentication even for public packages. For
projects with packages from multiple registries, configure only the `@fir3st`
scope. Follow [GitHub's installation guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#installing-a-package).
Do not put authentication material into application source.

Prereleases use the `next` dist-tag. Pin a specific version for reproducible builds;
alpha versions can include breaking changes. See [migration](api.md#migration-table).

## Browser modules

The archive includes `dist/index.js`, relative ESM dependencies and TypeScript
declarations. Serve the complete `dist/` directory over HTTP; a bundler is optional.

```html
<div id="map" style="height: 400px"></div>
<script type="module">
  import { createMap } from './dist/index.js';
  const map = await createMap('map', { center: [50.08, 14.44], zoom: 8 });
  map.addPoints([{ position: [50.08, 14.44] }]);
</script>
```

Keep `dist/workers/import.worker.js` with the module graph. A bundler must preserve
or rewrite its relative worker URL. A missing or blocked worker can reject the
first import with `worker-failed`; later imports use inline preparation.

## Requirements

- A browser with WebGPU or WebGL 1 for built-in rendering. WebGPU is attempted first,
  then WebGL 1; use `renderer: 'webgl1'` to request WebGL directly.
- A container with a nonzero size. Map controls are optional.
- Node.js 22+ only for building the source, not for using a map in the browser.

The package has no runtime npm dependencies. Math helpers are available from
`@fir3st/maplet/math`, and GeoJSON helpers from `@fir3st/maplet/formats`.
GPU validation currently covers Chromium; see [portability limits](status.md#known-limitations).
