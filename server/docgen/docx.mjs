import { buildZip, xml } from './zipwriter.mjs'

/* ============================================================
   DOCX writer
   -----------
   A .docx is a ZIP of OOXML parts. The minimum Word will open is:
     [Content_Types].xml, _rels/.rels, word/document.xml
   plus styles.xml so headings and code look like headings and code
   rather than undifferentiated body text.

   Twips are the unit throughout: 1 pt = 20 twips, 1 inch = 1440.
   ============================================================ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

/** Half-point sizes, as OOXML expects (`w:sz` is in half-points). */
const HEADING_SIZES = { 1: 40, 2: 30, 3: 26, 4: 23, 5: 22, 6: 22 }

function styles(bodyFont) {
  const heading = (level) => `
<w:style w:type="paragraph" w:styleId="Heading${level}">
  <w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 320 : 260}" w:after="${level === 1 ? 140 : 110}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="${bodyFont}" w:hAnsi="${bodyFont}"/><w:b/><w:sz w:val="${HEADING_SIZES[level]}"/><w:color w:val="14161A"/></w:rPr>
</w:style>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
  <w:rFonts w:ascii="${bodyFont}" w:hAnsi="${bodyFont}" w:cs="${bodyFont}"/><w:sz w:val="22"/><w:szCs w:val="22"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3, 4, 5, 6].map(heading).join('')}
<w:style w:type="paragraph" w:styleId="Code">
  <w:name w:val="Code"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:shd w:val="clear" w:fill="F5F6F8"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
  <w:ind w:left="220"/><w:contextualSpacing/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Quote">
  <w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9CDD4"/></w:pBdr></w:pPr>
  <w:rPr><w:i/><w:color w:val="4A4F57"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Title">
  <w:name w:val="Title"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:after="80"/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="56"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Subtitle">
  <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
  <w:rPr><w:sz w:val="26"/><w:color w:val="5A6070"/></w:rPr>
</w:style>
<w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/>
  <w:tblPr><w:tblBorders>
    ${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D3D7DE"/>`)
      .join('')}
  </w:tblBorders></w:tblPr>
</w:style>
</w:styles>`
}

/** Breaks a text run at explicit newlines, which OOXML needs as `<w:br/>`. */
function runs(text, extra = '') {
  return String(text)
    .split('\n')
    .map((part, i) => `${i > 0 ? '<w:br/>' : ''}<w:r>${extra}<w:t xml:space="preserve">${xml(part)}</w:t></w:r>`)
    .join('')
}

function paragraph(text, { style = null, bold = false, size = null, colour = null, indent = 0, spaceAfter = null } = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    indent ? `<w:ind w:left="${indent}"/>` : '',
    spaceAfter !== null ? `<w:spacing w:after="${spaceAfter}"/>` : '',
  ].join('')
  const rPr = [bold ? '<w:b/>' : '', size ? `<w:sz w:val="${size}"/>` : '', colour ? `<w:color w:val="${colour}"/>` : ''].join('')
  const rPrTag = rPr ? `<w:rPr>${rPr}</w:rPr>` : ''
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs(text, rPrTag)}</w:p>`
}

/** A list item. Word renders a real bullet from the numbering part; a literal
 *  glyph plus a hanging indent is simpler and looks identical in every reader. */
function listItem(text, ordered, index) {
  const depth = Math.floor((text.length - text.trimStart().length) / 2)
  const marker = ordered ? `${index + 1}.` : '•'
  const left = 360 + depth * 360
  return `<w:p><w:pPr><w:ind w:left="${left + 360}" w:hanging="360"/><w:spacing w:after="60"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${xml(marker)}\t</w:t></w:r>` +
    runs(text.trimStart()) +
    '</w:p>'
}

function table(rows) {
  const columns = Math.max(...rows.map((r) => r.length))
  const width = Math.floor(9360 / columns) // 6.5in of usable width, in twips

  const cell = (text, isHeader) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (isHeader ? '<w:shd w:val="clear" w:fill="F1F3F6"/>' : '') +
    '</w:tcPr>' +
    paragraph(text, { bold: isHeader, spaceAfter: 40 }) +
    '</w:tc>'

  const body = rows
    .map((row, r) => {
      const cells = Array.from({ length: columns }, (_, c) => cell(String(row[c] ?? ''), r === 0))
      // tblHeader repeats the header row when the table splits across pages
      return `<w:tr>${r === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`
    })
    .join('')

  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D3D7DE"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    body +
    '</w:tbl>' +
    // A table must not be the last element in a body cell-free context; an empty
    // paragraph after it also stops the next block sticking to the border.
    '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
  )
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return paragraph(block.text, { style: `Heading${Math.min(block.level, 6)}` })
    case 'paragraph':
      return paragraph(block.text)
    case 'list':
      return block.items.map((item, i) => listItem(item, block.ordered, i)).join('')
    case 'code':
      // One paragraph per line keeps the shading contiguous and the text exact
      return (
        String(block.text)
          .replace(/\n+$/, '')
          .split('\n')
          .map((line) => paragraph(line || ' ', { style: 'Code' }))
          .join('') + '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
      )
    case 'table':
      return table(block.rows)
    case 'quote':
      return paragraph(block.text, { style: 'Quote' })
    case 'rule':
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D3D7DE"/></w:pBdr></w:pPr></w:p>'
    default:
      return ''
  }
}

/**
 * Builds a .docx.
 *
 * @param {{ blocks: object[], title?: string, subtitle?: string, author?: string,
 *           bodyFont?: string, coverPage?: boolean }} input
 * @returns {Buffer}
 */
export function buildDocx({ blocks, title = 'Document', subtitle = '', author = 'PixGPT', bodyFont = 'Calibri', coverPage = true }) {
  const cover = coverPage
    ? paragraph(title, { style: 'Title' }) +
      (subtitle ? paragraph(subtitle, { style: 'Subtitle' }) : '') +
      '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="D3D7DE"/></w:pBdr></w:pPr></w:p>'
    : ''

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${cover}
${blocks.map(renderBlock).join('\n')}
<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>`

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(title)}</dc:title><dc:creator>${xml(author)}</dc:creator>
<cp:lastModifiedBy>${xml(author)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T12:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T12:00:00Z</dcterms:modified>
</cp:coreProperties>`

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>PixGPT</Application></Properties>`

  return buildZip([
    // [Content_Types].xml must be the first entry in an OOXML package
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: styles(bodyFont) },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
  ])
}
