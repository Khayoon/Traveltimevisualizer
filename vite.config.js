import { defineConfig } from 'vite';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [{
    name: 'ship-compressed-road-graphs',
    apply: 'build',
    async closeBundle() {
      // These are generated copies only; source graphs stay in public/data.
      // The worker reads the much smaller .json.gz assets first.
      await Promise.all(['gta', 'ontario'].map(mode =>
        unlink(path.join(root, 'dist', 'data', `${mode}.json`)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        })
      ));
    },
  }],
});
