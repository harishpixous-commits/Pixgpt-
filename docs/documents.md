# Documents — reading, writing and editing

PixGPT reads documents you attach, writes real PDF / Word / PowerPoint files, and
edits specific regions of an existing PDF.

All of it is dependency-free. These are documented file formats, and the
alternative was a rendering stack an order of magnitude larger than PixGPT for
one feature. Covered by `tests/docgen.test.mjs` (86 tests).

---

## Reading an attached document

Attach a file in the composer and ask about it. The server extracts text and
injects it as an ordinary text part, so it works on every model and every
gateway — no vision or file-API capability needed.

| Format | Extensions | Extractor |
|---|---|---|
| Plain text | `txt` `log` `text` | native |
| Markdown | `md` `markdown` `mdx` | native |
| CSV / TSV | `csv` `tsv` | native (quoted fields, escaped quotes) |
| JSON | `json` `jsonl` `ndjson` | native, validated and pretty-printed |
| Source code | `js` `ts` `py` `go` `rs` `java` `sql` `yaml` … | native |
| Word | `docx` | `mammoth` |
| PDF | `pdf` | native — see [capabilities.md](./capabilities.md#pdf-reading) |

Verified live: a PDF the model had never seen, asked three questions — it read the
budget and the owner, read the deadline and the no-extension clause, and when
asked about an auditor the memo never mentions, said so instead of inventing one.

---

## Writing a document

Three ways in:

| Route | For |
|---|---|
| `POST /api/documents/compose` | the model writes it — "a one-page summary of our Q3 results, with a table" |
| `POST /api/documents/generate` | content already exists — turn a chat reply into a file |
| `generate_document` tool | Build mode, saving into the project |

In the UI: **More options → Create a document**. Pick a format, describe what it
should contain, optionally use the conversation as reference material.

Files are stored under a short-lived id and downloaded with a plain `GET`, so the
bytes never have to be base64'd into a JSON reply and the browser drives the
download normally. They expire after 30 minutes.

### Formats

| Format | Produced |
|---|---|
`pdf` | objects, xref, trailer, base-14 fonts, WinAnsi text
`docx` | OOXML — `document.xml`, `styles.xml`, content types, relationships
`pptx` | OOXML — presentation, slide master, layout, theme, one part per slide
`html` | a single self-contained page, light and dark
`md` / `txt` | the content itself

The model writes Markdown — which it is good at — and each writer renders that.
One heading becomes a slide in `pptx`, a section in `pdf` and `docx`.

### The PDF writer

`server/docgen/pdf.mjs`. Real layout, not a text dump:

* **Word wrapping against real font metrics.** Adobe's published advance widths
  for the base-14 fonts (`metrics.mjs`). Without them you either guess a fixed
  character width — which overflows the margin on capitals — or you embed a font.
* **Monospace wrapping that preserves every space**, because code indentation
  carries meaning and the space-collapsing path is wrong for it.
* **Automatic pagination**, with headings kept next to their first line of body.
* **Tables** with content-derived column widths, wrapped cells, and the header
  row repeated when a table splits across pages.
* **Code blocks** on a tinted panel with a language label.
* **Page numbers**, stamped at save time when the total is known.
* Content streams are Flate-compressed — typically 60–80% smaller.

Unicode is mapped to WinAnsi, with substitutions for characters that have no
glyph (`→` becomes `->`), so a document never silently loses text.

Verified by rendering in Edge's PDF viewer and looking at the result.

### OOXML validation

Every generated `.docx` and `.pptx` is checked structurally: the ZIP central
directory parses with correct CRCs and sizes, `[Content_Types].xml` is the first
entry, every part is well-formed XML per a real XML parser, every relationship
target resolves, and every declared part exists.

---

## Editing a PDF

Change a region of a PDF you already have.

| Route | For |
|---|---|
| `POST /api/documents/pdf/inspect` | read it: page count, dimensions, text per page, find a phrase |
| `POST /api/documents/pdf/modify` | describe the change in plain language; the model works out where |
| `POST /api/documents/pdf/edit` | you already know the regions |

In the UI: **More options → Edit a PDF**. The page text is read and shown first,
because knowing what the document contains is what makes it possible to write an
instruction the model can act on.

### Actions

| Action | Effect |
|---|---|
| `replace_text` | cover the region and write new text over it |
| `add_text` | write text without covering anything |
| `cover` | hide the region with a filled rectangle |
| `redact` | cover it in black |
| `highlight` | tint it, leaving the text readable underneath (Multiply blending) |
| `box` | draw an outline around it |

### Coordinates

`units: "fraction"` takes proportions of the page with the origin at the
**top-left** — which is how a person describes "the top right corner" and how a
vision model reports a bounding box. `units: "points"` takes PDF points from the
bottom-left, with `fromTop: true` available.

### How it works

The document is parsed into its objects, the target page's content array is
extended with an overlay stream, and the whole file is written out fresh with a
new xref. A full rewrite rather than an incremental update, because appending to
a file that uses xref streams means emitting a hybrid table some readers
mishandle — and a rewrite is always valid.

**Original content is never discarded.** The overlay is appended after the
existing content, so what was there still draws underneath. Verified: after
editing, the original text is still extractable and the new text is present.

Fonts and the blend-mode graphics state are merged into a private copy of the
page's resources, so a dictionary other pages also point at is never mutated.

---

## Limits

| Guard | Variable | Default |
|---|---|---|
| Attached file size | `MAX_FILE_SIZE_MB` | 5 MB |
| Extracted text per file | `MAX_DOCUMENT_TEXT` | 120,000 chars |
| Files per message | `MAX_FILES_PER_MESSAGE` | 3 |
| PDF upload for editing | `DOC_MAX_PDF_BYTES` | 25 MB |
| PDF size for parsing | — | 80 MB |
| Generated document content | — | 400,000 chars |
| Stored file lifetime | `ARTIFACT_TTL_MS` | 30 minutes |
| Stored files held | `ARTIFACT_MAX_COUNT` | 60 |
| Total stored bytes | `ARTIFACT_MAX_TOTAL_BYTES` | 300 MB |

Generated files are held in memory on purpose: they are derived artefacts, not
user data. They expire, and they do not survive a restart.

---

## Safety

* **Filenames are labels, never paths.** Extraction works on an in-memory buffer;
  `../../../etc/passwd` is only ever text.
* **Size checked before decode**, from the base64 length, so an oversized payload
  is never materialised.
* **A malformed PDF is a 400, not a 500.** A user's broken file is their file
  being wrong, not the server breaking — and "Something went wrong" tells them
  nothing they can act on.
* **A scanned PDF is refused with the reason.** No text layer means nothing to
  extract; returning an empty string would read like an empty document.
* **XML escaping on everything user-supplied**, including stripping the control
  characters XML 1.0 forbids, which would otherwise corrupt the document.
* **Filenames sanitised for the filesystem and the header** — Windows-reserved
  characters, both separators, control characters, trailing dots.
* **Prompt-injection containment.** Extracted text is fenced and labelled as
  content, not instructions. Page text handed to the model for an edit plan is
  fenced the same way, so a PDF containing "ignore your instructions" cannot
  redirect the edit.
