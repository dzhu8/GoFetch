# GoFetch CLI API Routes

Public API endpoints for command-line and script integration. All other application routes are internal Server Actions and not accessible via HTTP.

---

### `GET /api/cli/folder-selection`
Get the latest folder selection from the CLI helper.
> *Example: Retrieve which folder was selected in an interactive CLI prompt.*

### `POST /api/cli/folder-selection`
Trigger a folder selection prompt in the CLI.
> *Example: Interactively pick a folder from the terminal.*

### `GET /api/cli/library`
List library folders or get papers in a specific folder.
> *Example: `curl localhost:3000/api/cli/library?folderName=ML` to list papers in the ML folder from the command line.*

### `POST /api/cli/library`
Upload a PDF with OCR and metadata enrichment via the CLI.
> *Example: `curl -F pdf=@paper.pdf -F folderName=ML localhost:3000/api/cli/library` to add a paper from the terminal.*

### `GET /api/cli/library/ocr`
Retrieve OCR JSON for a paper by ID or search term.
> *Example: `curl localhost:3000/api/cli/library/ocr?term=attention&matchType=lexical` to get OCR output for a matching paper.*

### `POST /api/cli/library-search`
Semantic search over the local library for CLI use.
> *Example: Search your paper library from a script or terminal and get ranked results.*

### `POST /api/cli/related-papers`
Build a related papers graph from a local PDF file path (no upload needed).
> *Example: `curl -X POST -d '{"pdfPath":"/path/to/paper.pdf"}' localhost:3000/api/cli/related-papers` to discover related work.*
