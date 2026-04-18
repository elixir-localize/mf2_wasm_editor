# License

Copyright 2026 Kip Cole

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

## Third-party notices

This package bundles and distributes the following third-party artefacts:

* **`priv/static/tree-sitter.js`** and **`priv/static/tree-sitter.wasm`** are copied verbatim from the [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) npm package (MIT). The upstream licence text is preserved at `priv/static/tree-sitter.LICENSE.txt`.

* **`priv/static/tree-sitter-mf2.wasm`**, **`priv/static/highlights.scm`**, and the grammar sources under `priv/grammar/` are copied from [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) (Apache-2.0). The WASM ships prebuilt in the grammar repo; `mix mf2_wasm_editor.sync --build-wasm` can rebuild it locally against the vendored grammar source.
