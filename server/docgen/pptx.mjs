import { buildZip, xml } from './zipwriter.mjs'

/* ============================================================
   PPTX writer
   -----------
   A .pptx is a ZIP of OOXML parts: a presentation, a slide master, a
   layout, and one part per slide, each wired together by relationship
   files. PowerPoint refuses to open the package if any link is missing,
   so all of them are written.

   EMU is the unit: 1 inch = 914400, 1 pt = 12700.
   16:9 at 13.333 x 7.5 inches.
   ============================================================ */

const EMU_PER_INCH = 914400
const SLIDE_W = Math.round(13.333 * EMU_PER_INCH)
const SLIDE_H = Math.round(7.5 * EMU_PER_INCH)

const MARGIN = Math.round(0.6 * EMU_PER_INCH)
const TITLE_TOP = Math.round(0.45 * EMU_PER_INCH)
const TITLE_H = Math.round(1.1 * EMU_PER_INCH)
const BODY_TOP = TITLE_TOP + TITLE_H + Math.round(0.15 * EMU_PER_INCH)

/** Body lines that fit one slide before the text has to shrink. */
const COMFORTABLE_LINES = 9

function contentTypes(slideCount) {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

function presentation(slideCount) {
  const ids = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst>
<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>
<p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`
}

function presentationRels(slideCount) {
  const slides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slides}
<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`
}

/* ---------- master, layout, theme ---------- */

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>
<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"
 accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"
 hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`

const SLIDE_MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>
<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"
 accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4"
 accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sldLayout>`

const SLIDE_LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`

/** Minimal but complete theme — PowerPoint validates the full colour scheme. */
function theme(accent) {
  const scheme = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
  scheme[0] = accent
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PixGPT">
<a:themeElements>
<a:clrScheme name="PixGPT">
<a:dk1><a:srgbClr val="14161A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="F2F4F7"/></a:lt2>
${scheme.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('')}
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="PixGPT">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
${[6350, 12700, 19050]
  .map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`)
  .join('')}
</a:lnStyleLst>
<a:effectStyleLst>
${[1, 2, 3].map(() => '<a:effectStyle><a:effectLst/></a:effectStyle>').join('')}
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`
}

const SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`

/* ---------- shapes ---------- */

function textBox({ id, name, x, y, w, h, paragraphs, anchor = 't' }) {
  return `<p:sp>
<p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>
${paragraphs}
</p:txBody></p:sp>`
}

function para(text, { size = 18, bold = false, colour = '1F2430', bullet = false, indent = 0, mono = false, align = 'l', spaceBefore = 0 } = {}) {
  const marL = bullet ? 285750 + indent * 285750 : indent * 285750
  const props = [
    `lvl="0"`,
    `algn="${align}"`,
    marL ? `marL="${marL}"` : '',
    bullet ? `indent="-285750"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const bulletTag = bullet ? '<a:buChar char="&#8226;"/>' : '<a:buNone/>'
  const font = mono ? '<a:latin typeface="Consolas"/>' : ''
  const runProps = `<a:rPr lang="en-US" sz="${Math.round(size * 100)}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>${font}</a:rPr>`

  // An empty paragraph still needs an endParaRPr or PowerPoint drops the spacing
  if (!String(text).trim()) {
    return `<a:p><a:pPr ${props}>${bulletTag}</a:pPr><a:endParaRPr sz="${Math.round(size * 100)}"/></a:p>`
  }
  return `<a:p><a:pPr ${props}>${spaceBefore ? `<a:spcBef><a:spcPts val="${spaceBefore}"/></a:spcBef>` : ''}${bulletTag}</a:pPr>` +
    `<a:r>${runProps}<a:t>${xml(text)}</a:t></a:r></a:p>`
}

/** Flattens a slide's blocks into paragraph XML, shrinking text if it is dense. */
function slideBody(blocks) {
  const lines = []
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        lines.push({ text: block.text, opts: {} })
        break
      case 'list':
        block.items.forEach((item, i) => {
          const depth = Math.floor((item.length - item.trimStart().length) / 2)
          lines.push({
            text: block.ordered ? `${i + 1}. ${item.trimStart()}` : item.trimStart(),
            opts: { bullet: !block.ordered, indent: depth },
          })
        })
        break
      case 'heading':
        lines.push({ text: block.text, opts: { bold: true, spaceBefore: 600 } })
        break
      case 'code':
        for (const line of String(block.text).replace(/\n+$/, '').split('\n')) {
          lines.push({ text: line || ' ', opts: { mono: true, size: 12, colour: '2A3140' } })
        }
        break
      case 'quote':
        lines.push({ text: `“${block.text}”`, opts: { colour: '4A5060' } })
        break
      case 'table':
        // A slide is not a spreadsheet: render as aligned rows rather than a grid
        block.rows.forEach((row, r) => {
          lines.push({ text: row.join('   ·   '), opts: { bold: r === 0, mono: true, size: 12 } })
        })
        break
      default:
        break
    }
  }

  // Scale down rather than overflow the slide
  const scale = lines.length > COMFORTABLE_LINES ? Math.max(0.62, COMFORTABLE_LINES / lines.length) : 1
  return lines
    .map(({ text, opts }) => para(text, { ...opts, size: Math.round((opts.size ?? 18) * scale * 10) / 10 }))
    .join('')
}

function slideXml({ title, blocks, index, total, accent, footer }) {
  const shapes = []
  let id = 2

  // Accent bar above the title — visual anchor, no image needed
  shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${MARGIN}" y="${TITLE_TOP - 120000}"/><a:ext cx="${Math.round(0.9 * EMU_PER_INCH)}" cy="61000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`)

  if (title) {
    shapes.push(
      textBox({
        id: id++,
        name: 'Title',
        x: MARGIN,
        y: TITLE_TOP,
        w: SLIDE_W - MARGIN * 2,
        h: TITLE_H,
        paragraphs: para(title, { size: title.length > 60 ? 26 : 32, bold: true, colour: '14161A' }),
      }),
    )
  }

  const body = slideBody(blocks)
  if (body) {
    shapes.push(
      textBox({
        id: id++,
        name: 'Body',
        x: MARGIN,
        y: title ? BODY_TOP : TITLE_TOP,
        w: SLIDE_W - MARGIN * 2,
        h: SLIDE_H - (title ? BODY_TOP : TITLE_TOP) - MARGIN,
        paragraphs: body,
      }),
    )
  }

  // Slide number, and the deck name if one was given
  shapes.push(
    textBox({
      id: id++,
      name: 'Footer',
      x: MARGIN,
      y: SLIDE_H - Math.round(0.45 * EMU_PER_INCH),
      w: SLIDE_W - MARGIN * 2,
      h: Math.round(0.3 * EMU_PER_INCH),
      paragraphs:
        para(footer ?? '', { size: 10, colour: '8A9099' }) +
        para(`${index + 1} / ${total}`, { size: 10, colour: '8A9099', align: 'r' }),
    }),
  )

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>
<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapes.join('\n')}
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

/**
 * Builds a .pptx.
 *
 * @param {{ slides: {title:string, blocks:object[]}[], title?: string,
 *           subtitle?: string, author?: string, accent?: string }} input
 * @returns {Buffer}
 */
export function buildPptx({ slides, title = 'Presentation', subtitle = '', author = 'PixGPT', accent = '2E6BE6' }) {
  // Title slide first, then the content slides
  const deck = [
    {
      title: '',
      blocks: [
        { type: 'heading', level: 1, text: title },
        ...(subtitle ? [{ type: 'paragraph', text: subtitle }] : []),
      ],
      isTitle: true,
    },
    ...slides,
  ]

  const slideParts = deck.map((slide, index) => {
    if (slide.isTitle) {
      // The title slide gets a centred block rather than the header layout
      const paragraphs =
        para(title, { size: 44, bold: true, colour: '14161A' }) +
        (subtitle ? para(subtitle, { size: 20, colour: '5A6070', spaceBefore: 900 }) : '')
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>
<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${MARGIN}" y="${Math.round(2.35 * EMU_PER_INCH)}"/><a:ext cx="${Math.round(1.4 * EMU_PER_INCH)}" cy="76200"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
${textBox({ id: 3, name: 'Title', x: MARGIN, y: Math.round(2.6 * EMU_PER_INCH), w: SLIDE_W - MARGIN * 2, h: Math.round(2.4 * EMU_PER_INCH), paragraphs })}
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
    }
    return slideXml({
      title: slide.title,
      blocks: slide.blocks,
      index,
      total: deck.length,
      accent,
      footer: title.slice(0, 60),
    })
  })

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
<Application>PixGPT</Application><Slides>${slideParts.length}</Slides></Properties>`

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes(slideParts.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'ppt/presentation.xml', data: presentation(slideParts.length) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(slideParts.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: SLIDE_MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: SLIDE_LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: theme(accent) },
    ...slideParts.flatMap((data, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: SLIDE_RELS },
    ]),
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
  ])
}
