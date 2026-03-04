// src/agent/utils/pdf.ts
import PDFDocument from 'pdfkit';
import fs from 'fs';

// CONFIGURACIÓN DE RUTAS DE IMÁGENES
const IMAGE_PATHS = {
  cover: "./cover.jpg",
  logo: './logo.png',
  watermark: './assets/watermark.png',
  headerLogo: './header.png'
};

// COLORES DEL TEMA
const COLORS = {
  darkBlue: '#1F4788',
  lightGray: '#C0C0C0',
  linkBlue: '#0563C1',
  white: '#FFFFFF',
  black: '#000000',
  backgroundGray: '#F5F5F5'
};

interface ReportSection {
  title?: string;
  content: string;
}

interface ReportData {
  title: string;
  summary: string;
  sections: ReportSection[];
  metadata?: {
    sources?: string[];
  };
}

export async function buildPdfFromReport(finalReport: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 70,
          bottom: 70,
          left: 50,
          right: 50
        },
        bufferPages: true,
        info: {
          Title: finalReport.title,
          Author: 'Grupo Lead',
          Subject: 'Informe de Coyuntura',
          Creator: 'Sistema de Reportes Lead'
        }
      });

      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const tableOfContents: { title: string; page: number; level: number }[] = [];

      // ============================================
      // PORTADA
      // ============================================
      createCoverPage(doc, finalReport.title);

      // Extraer entradas del índice
      const tocEntriesOnly = extractTocEntries(finalReport);

      // Reservar páginas del TOC
      const tocPageCount = reserveTocPages(doc, tocEntriesOnly.length);

      // ============================================
      // CONTENIDO
      // ============================================
      doc.addPage();

      const checkSpaceAndAddPage = (requiredSpace: number = 150) => {
        const pageHeight = doc.page.height;
        const bottomMargin = 70;
        const availableSpace = pageHeight - bottomMargin - doc.y;

        if (availableSpace < requiredSpace) {
          doc.addPage();
          return true;
        }
        return false;
      };

      // Introducción
      tableOfContents.push({
        title: 'Introducción',
        page: doc.bufferedPageRange().count,
        level: 1
      });

      doc.fontSize(20)
        .fillColor(COLORS.darkBlue)
        .font('Helvetica-Bold')
        .text('Introducción', { underline: false });

      doc.moveDown(0.5);

      renderContent(
        doc,
        finalReport.summary || '',
        tableOfContents,
        () => doc.bufferedPageRange().count,
        checkSpaceAndAddPage
      );

      // Secciones del reporte
      if (Array.isArray(finalReport.sections)) {
        for (const section of finalReport.sections) {
          checkSpaceAndAddPage(200);
          doc.moveDown(2);

          // Agregar título de sección al TOC si existe
          if (section.title) {
            tableOfContents.push({
              title: section.title,
              page: doc.bufferedPageRange().count,
              level: 1
            });

            doc.fontSize(20)
              .fillColor(COLORS.darkBlue)
              .font('Helvetica-Bold')
              .text(section.title, { underline: false });

            doc.moveDown(0.5);
          }

          const sectionContent = removeRedundantTitle(
            typeof section?.content === 'string' ? section.content : String(section?.content ?? ''),
            section.title
          );

          if (sectionContent.trim()) {
            renderContent(
              doc,
              sectionContent,
              tableOfContents,
              () => doc.bufferedPageRange().count,
              checkSpaceAndAddPage
            );
          }
        }
      }

      // ============================================
      // GENERAR ÍNDICE
      // ============================================
      if (tocPageCount > 0) {
        writeTableOfContentsToRange(doc, tableOfContents, 1, tocPageCount, 0);
      }

      // Agregar marca de agua y encabezado/pie
      addWatermarkToAllPages(doc);
      addHeaderFooterToAllPages(doc);

      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Renderiza contenido markdown a PDF
 */
function renderContent(
  doc: PDFKit.PDFDocument,
  markdown: string,
  toc: { title: string; page: number; level: number }[],
  getCurrentPage: () => number,
  checkSpaceAndAddPage: (requiredSpace?: number) => boolean
): void {
  const lines = markdown.split('\n');
  let inCodeBlock = false;
  let inList = false;
  let codeBlockContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Código en bloque
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        const codeHeight = codeBlockContent.split('\n').length * 15 + 40;
        checkSpaceAndAddPage(codeHeight);
        addCodeBlock(doc, codeBlockContent);
        codeBlockContent = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n';
      continue;
    }

    // Headings (solo sub-headings, nivel 2+)
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];

      checkSpaceAndAddPage(level === 2 ? 80 : 60);

      toc.push({ title: text, page: getCurrentPage(), level: level - 1 });

      doc.moveDown(level === 2 ? 0.8 : 0.5);

      const fontSize = level === 2 ? 16 : level === 3 ? 14 : 12;
      doc.fontSize(fontSize)
        .fillColor(COLORS.darkBlue)
        .font('Helvetica-Bold')
        .text(text);

      doc.moveDown(0.5);
      continue;
    }

    // Tablas
    if (line.trim().startsWith('|')) {
      const tableRows: string[][] = [];
      let j = i;

      while (j < lines.length && lines[j].trim().startsWith('|')) {
        const row = lines[j]
          .split('|')
          .map(cell => cell.trim())
          .filter(cell => cell.length > 0);

        if (!row.every(cell => /^-+$/.test(cell))) {
          tableRows.push(row);
        }
        j++;
      }

      const tableHeight = tableRows.length * 25 + 40;
      checkSpaceAndAddPage(tableHeight);

      addTable(doc, tableRows, checkSpaceAndAddPage);
      i = j - 1;
      continue;
    }

    // Listas
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const bullet = listMatch[2];
      const text = listMatch[3];

      checkSpaceAndAddPage(40);

      if (!inList) {
        doc.moveDown(0.3);
        inList = true;
      }

      doc.fontSize(11)
        .fillColor(COLORS.black)
        .font('Helvetica')
        .text(`${bullet.startsWith('-') || bullet.startsWith('*') ? '•' : bullet} ${text}`, {
          indent: 20 + indent * 10
        });

      doc.moveDown(0.2);
      continue;
    } else {
      inList = false;
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const text = line.replace(/^>\s*/, '');
      checkSpaceAndAddPage(40);

      doc.moveDown(0.3);
      doc.fontSize(11)
        .fillColor('#666666')
        .font('Helvetica-Oblique')
        .text(text, { indent: 30 });
      doc.moveDown(0.3);
      continue;
    }

    // Párrafos normales
    if (line.trim().length > 0) {
      checkSpaceAndAddPage(40);
      addFormattedParagraph(doc, line);
      doc.moveDown(0.3);
    } else {
      doc.moveDown(0.5);
    }
  }
}

/**
 * Extrae entradas del TOC desde las secciones del reporte
 */
function extractTocEntries(report: ReportData): { title: string; level: number }[] {
  const toc: { title: string; level: number }[] = [];

  // Introducción
  toc.push({ title: 'Introducción', level: 1 });

  // Extraer sub-headings del summary
  const summaryHeadings = extractHeadingsFromMarkdown(report.summary);
  toc.push(...summaryHeadings);

  // Secciones principales
  if (Array.isArray(report.sections)) {
    for (const section of report.sections) {
      if (section.title) {
        toc.push({ title: section.title, level: 1 });
      }

      const sectionContent = typeof section?.content === 'string'
        ? section.content
        : String(section?.content ?? '');

      const sectionHeadings = extractHeadingsFromMarkdown(sectionContent);
      toc.push(...sectionHeadings);
    }
  }

  return toc;
}

/**
 * Extrae headings de markdown (nivel 2+)
 */
function extractHeadingsFromMarkdown(markdown?: string): { title: string; level: number }[] {
  if (!markdown) return [];

  const headings: { title: string; level: number }[] = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    const match = line.match(/^(#{2,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length - 1; // Ajustar nivel (h2 -> level 1, etc.)
      const text = match[2].trim();
      headings.push({ title: text, level });
    }
  }

  return headings;
}

/**
 * Elimina la primera línea si es un heading o negritas que coincide con el título
 */
function removeRedundantTitle(content: string, sectionTitle?: string): string {
  if (!sectionTitle || !content) return content;

  const lines = content.split('\n');
  if (lines.length === 0) return content;

  const firstLine = lines[0].trim();

  // Normalizar título de sección (remover prefijos como "I.", "II.", etc.)
  const normalizedTitle = sectionTitle.trim().replace(/^[IVX]+\.\s*/, '');

  // Caso 1: Heading (cualquier nivel ###, ##, #)
  const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    const headingText = headingMatch[1].trim().replace(/^[IVX]+\.\s*/, '');
    if (headingText === normalizedTitle || headingMatch[1].trim() === sectionTitle.trim()) {
      return lines.slice(1).join('\n'); // Eliminar primera línea
    }
  }

  // Caso 2: Negritas **texto**
  const boldMatch = firstLine.match(/^\*\*(.+)\*\*$/);
  if (boldMatch) {
    const boldText = boldMatch[1].trim().replace(/^[IVX]+\.\s*/, '');
    if (boldText === normalizedTitle || boldMatch[1].trim() === sectionTitle.trim()) {
      return lines.slice(1).join('\n'); // Eliminar primera línea
    }
  }

  return content;
}

/**
 * Reserva páginas para el TOC
 */
function reserveTocPages(doc: PDFKit.PDFDocument, tocEntryCount: number): number {
  const pageHeight = doc.page.height;
  const topMargin = 70;
  const bottomMargin = 100;
  const usable = pageHeight - topMargin - bottomMargin;

  const titleSpace = 60;
  const firstPageUsable = usable - titleSpace;
  const approxLineHeight = 18;

  const entriesFirstPage = Math.floor(firstPageUsable / approxLineHeight);

  if (tocEntryCount <= entriesFirstPage) {
    doc.addPage();
    return 1;
  }

  const remainingEntries = tocEntryCount - entriesFirstPage;
  const entriesPerPage = Math.floor(usable / approxLineHeight);
  const additionalPages = Math.ceil(remainingEntries / entriesPerPage);

  const totalPages = 1 + additionalPages;

  for (let i = 0; i < totalPages; i++) {
    doc.addPage();
  }

  return totalPages;
}

/**
 * Escribe el TOC en las páginas reservadas
 */
function writeTableOfContentsToRange(
  doc: PDFKit.PDFDocument,
  toc: { title: string; page: number; level: number }[],
  startIndex: number,
  pageCount: number,
  pageOffset: number
): void {
  let entryIndex = 0;
  const pageHeight = doc.page.height;
  const bottomMargin = 100;
  const maxY = pageHeight - bottomMargin;

  for (let p = 0; p < pageCount; p++) {
    const pageIdx = startIndex + p;
    doc.switchToPage(pageIdx);

    doc.save();
    doc.fillColor(COLORS.white).rect(0, 0, doc.page.width, doc.page.height).fill();
    doc.restore();

    doc.x = 50;
    doc.y = 70;

    if (p === 0) {
      doc.fontSize(20)
        .fillColor(COLORS.darkBlue)
        .font('Helvetica-Bold')
        .text('Índice');
      doc.moveDown(1.5);
    }

    while (entryIndex < toc.length) {
      const item = toc[entryIndex];
      const indent = (item.level - 1) * 20;
      const pageWidth = doc.page.width;

      const fontSize = item.level === 1 ? 12 : 10;
      const estimatedHeight = fontSize + 8;

      if (doc.y + estimatedHeight > maxY) {
        break;
      }

      const startY = doc.y;

      doc.fontSize(fontSize)
        .fillColor(item.level === 1 ? COLORS.darkBlue : COLORS.black)
        .font(item.level === 1 ? 'Helvetica-Bold' : 'Helvetica');

      const titleText = item.title;
      const availableWidth = pageWidth - 150 - indent;
      const titleWidth = Math.min(doc.widthOfString(titleText), availableWidth);

      doc.text(titleText, 50 + indent, startY, {
        continued: false,
        width: availableWidth,
        lineBreak: false,
        ellipsis: true
      });

      const dotsStart = 50 + indent + titleWidth + 5;
      const dotsEnd = pageWidth - 80;
      const dotsWidth = Math.max(0, dotsEnd - dotsStart);
      const numDots = Math.max(0, Math.floor(dotsWidth / 3));
      const dots = '.'.repeat(numDots);

      if (numDots > 0) {
        doc.fontSize(10)
          .fillColor(COLORS.lightGray)
          .font('Helvetica')
          .text(dots, dotsStart, startY, {
            continued: false,
            lineBreak: false
          });
      }

      const displayedPage = Math.max(1, (item.page || 1) - 1);
      doc.fillColor(COLORS.darkBlue)
        .text(String(displayedPage + 1), pageWidth - 80, startY, {
          width: 30,
          align: 'right',
          lineBreak: false
        });

      doc.y = startY + estimatedHeight;
      entryIndex++;
    }

    if (entryIndex >= toc.length) {
      break;
    }
  }

  if (entryIndex < toc.length) {
    console.warn(`⚠️ TOC: Solo se pudieron escribir ${entryIndex} de ${toc.length} entradas en ${pageCount} página(s)`);
  }
}

/**
 * Crea la portada
 */
function createCoverPage(doc: PDFKit.PDFDocument, title: string): void {
  try {
    if (fs.existsSync(IMAGE_PATHS.cover)) {
      doc.image(IMAGE_PATHS.cover, 0, 0, {
        width: doc.page.width,
        height: doc.page.height
      });
    }
  } catch (error) {
    console.log('Cover no encontrado, continuando sin cover...');
  }
}

/**
 * Agrega párrafo con formato markdown inline
 */
function addFormattedParagraph(doc: PDFKit.PDFDocument, text: string): void {
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\$\$[^$]+\$\$|\$[^$]+\$|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  doc.fontSize(11)
    .fillColor(COLORS.black)
    .font('Helvetica');

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      doc.text(text.substring(lastIndex, match.index), { continued: true });
    }

    const fullMatch = match[0];

    if (fullMatch.startsWith('**') && fullMatch.endsWith('**')) {
      doc.font('Helvetica-Bold')
        .text(fullMatch.slice(2, -2), { continued: true })
        .font('Helvetica');
    }
    else if (fullMatch.startsWith('*') && fullMatch.endsWith('*')) {
      doc.font('Helvetica-Oblique')
        .text(fullMatch.slice(1, -1), { continued: true })
        .font('Helvetica');
    }
    else if (fullMatch.startsWith('`') && fullMatch.endsWith('`')) {
      doc.font('Courier')
        .fillColor('#333333')
        .text(fullMatch.slice(1, -1), { continued: true })
        .font('Helvetica')
        .fillColor(COLORS.black);
    }
    else if (fullMatch.startsWith('$$') || fullMatch.startsWith('$')) {
      const mathText = fullMatch.startsWith('$$')
        ? fullMatch.slice(2, -2)
        : fullMatch.slice(1, -1);
      doc.font('Helvetica-Oblique')
        .fillColor(COLORS.linkBlue)
        .text(mathText, { continued: true })
        .font('Helvetica')
        .fillColor(COLORS.black);
    }
    else if (fullMatch.startsWith('[')) {
      const linkMatch = fullMatch.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        doc.fillColor(COLORS.linkBlue)
          .text(linkMatch[1], {
            link: linkMatch[2],
            underline: true,
            continued: true
          })
          .fillColor(COLORS.black);
      }
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    doc.text(text.substring(lastIndex), { continued: false });
  } else {
    doc.text('', { continued: false });
  }
}

/**
 * Agrega tabla
 */
function addTable(
  doc: PDFKit.PDFDocument,
  rows: string[][],
  checkSpaceAndAddPage: (requiredSpace?: number) => boolean
): void {
  if (rows.length === 0) return;

  const colWidth = (doc.page.width - 100) / rows[0].length;
  const rowHeight = 25;

  doc.moveDown(0.5);

  rows.forEach((row, rowIndex) => {
    checkSpaceAndAddPage(rowHeight + 10);

    const startY = doc.y;

    row.forEach((cell, colIndex) => {
      const x = 50 + colIndex * colWidth;

      if (rowIndex === 0) {
        doc.rect(x, startY, colWidth, rowHeight)
          .fill(COLORS.backgroundGray);
      }

      doc.strokeColor(COLORS.lightGray)
        .rect(x, startY, colWidth, rowHeight)
        .stroke();

      doc.fontSize(10)
        .fillColor(COLORS.black)
        .font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .text(cell, x + 5, startY + 7, {
          width: colWidth - 10,
          align: 'center',
          lineBreak: false
        });
    });

    doc.y = startY + rowHeight;
  });

  doc.x = 50;
  doc.moveDown(1);
}

/**
 * Agrega bloque de código
 */
function addCodeBlock(doc: PDFKit.PDFDocument, code: string): void {
  doc.moveDown(0.5);

  const codeY = doc.y;
  const codeHeight = code.split('\n').length * 15 + 20;

  doc.rect(50, codeY, doc.page.width - 100, codeHeight)
    .fill(COLORS.backgroundGray);

  doc.fontSize(9)
    .fillColor(COLORS.black)
    .font('Courier')
    .text(code, 60, codeY + 10, {
      width: doc.page.width - 120
    });

  doc.y = codeY + codeHeight;
  doc.x = 50;
  doc.moveDown(0.5);
}

/**
 * Agrega marca de agua
 */
function addWatermarkToAllPages(doc: PDFKit.PDFDocument): void {
  try {
    if (fs.existsSync(IMAGE_PATHS.watermark)) {
      const range = doc.bufferedPageRange();

      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);

        doc.save();
        doc.opacity(0.1);

        const watermarkSize = 300;
        const x = (doc.page.width - watermarkSize) / 2;
        const y = (doc.page.height - watermarkSize) / 2;

        doc.image(IMAGE_PATHS.watermark, x, y, {
          width: watermarkSize,
          height: watermarkSize
        });

        doc.restore();
      }
    }
  } catch (error) {
    console.log('Marca de agua no encontrada, continuando sin ella...');
  }
}

/**
 * Agrega encabezado y pie de página
 */
function addHeaderFooterToAllPages(doc: PDFKit.PDFDocument): void {
  try {
    const range = doc.bufferedPageRange();

    for (let i = range.start; i < range.start + range.count; i++) {
      if (i === range.start) continue;

      doc.switchToPage(i);
      doc.save();

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // Header con logo
      if (fs.existsSync(IMAGE_PATHS.headerLogo)) {
        doc.image(IMAGE_PATHS.headerLogo, pageWidth - 141, 30, {
          width: 91,
          height: 37
        });
      }

      // Línea footer
      doc.strokeColor(COLORS.darkBlue)
        .lineWidth(1)
        .moveTo(50, pageHeight - 50)
        .lineTo(pageWidth - 50, pageHeight - 50)
        .stroke();

      // Número de página
      const displayedPageNumber = i + 1;
      const pageNumberText = String(displayedPageNumber);
      doc.fontSize(10)
        .fillColor(COLORS.darkBlue)
        .font('Helvetica');

      const textWidth = doc.widthOfString(pageNumberText);
      const x = (pageWidth - textWidth) / 2;
      const y = pageHeight - 35;

      doc.text(pageNumberText, x, y, {
        lineBreak: false,
        continued: false
      });

      doc.restore();
    }
  } catch (error) {
    console.log('Error al dibujar headers/footers:', error);
  }
}