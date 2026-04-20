(function(globalScope) {
  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'log', 'sql', 'py', 'js', 'ts', 'tsx',
    'jsx', 'css', 'scss', 'less', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php',
    'rb', 'swift', 'kt', 'kts', 'sh', 'bat'
  ]);

  const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv']);
  const PRESENTATION_EXTENSIONS = new Set(['pptx', 'odp']);
  const OPENDOCUMENT_TEXT_EXTENSIONS = new Set(['odt']);
  const EPUB_EXTENSIONS = new Set(['epub']);
  const RTF_EXTENSIONS = new Set(['rtf']);
  const ZIP_LIKE_EXTENSIONS = new Set(['pages', 'key', 'numbers', 'zip']);

  async function extractText(file, options = {}) {
    const fileName = String(file?.name || '').trim();
    const mimeType = String(file?.type || '').toLowerCase();
    const extension = getExtension(fileName);

    if (isTextLike(extension, mimeType)) {
      return file.text();
    }

    if (isDocx(extension, mimeType)) {
      return extractDocxText(await file.arrayBuffer());
    }

    if (isPdf(extension, mimeType)) {
      requireRuntime(globalScope.pdfjsLib?.getDocument, 'PDF extraction runtime is not loaded');
      return extractPdfText(await file.arrayBuffer());
    }

    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      requireRuntime(globalScope.XLSX?.read, 'Spreadsheet extraction runtime is not loaded');
      return extractSpreadsheetText(await file.arrayBuffer(), fileName);
    }

    if (PRESENTATION_EXTENSIONS.has(extension) || isPresentationMime(mimeType)) {
      requireRuntime(globalScope.JSZip?.loadAsync, 'Presentation extraction runtime is not loaded');
      return extractPresentationText(await file.arrayBuffer(), extension);
    }

    if (OPENDOCUMENT_TEXT_EXTENSIONS.has(extension) || isOdtMime(mimeType)) {
      requireRuntime(globalScope.JSZip?.loadAsync, 'OpenDocument extraction runtime is not loaded');
      return extractOpenDocumentText(await file.arrayBuffer());
    }

    if (EPUB_EXTENSIONS.has(extension) || mimeType.includes('epub')) {
      requireRuntime(globalScope.JSZip?.loadAsync, 'EPUB extraction runtime is not loaded');
      return extractEpubText(await file.arrayBuffer());
    }

    if (RTF_EXTENSIONS.has(extension) || mimeType.includes('rtf')) {
      return cleanText(stripRtf(await file.text()));
    }

    if (ZIP_LIKE_EXTENSIONS.has(extension)) {
      requireRuntime(globalScope.JSZip?.loadAsync, 'Archive extraction runtime is not loaded');
      return extractGenericZipText(await file.arrayBuffer(), fileName);
    }

    throw new Error(`Unsupported local extraction type: ${mimeType || extension || 'unknown'}`);
  }

  async function extractPdfText(arrayBuffer) {
    const pdfData = new Uint8Array(arrayBuffer);
    const pdf = await globalScope.pdfjsLib.getDocument({ data: pdfData }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return cleanText(text);
  }

  async function extractDocxText(arrayBuffer) {
    if (globalScope.mammoth?.extractRawText) {
      try {
        const result = await globalScope.mammoth.extractRawText({ arrayBuffer });
        const text = cleanText(result?.value || '');
        if (text) {
          return text;
        }
      } catch {
        // Fall back to direct OOXML extraction below.
      }
    }

    requireRuntime(globalScope.JSZip?.loadAsync, 'DOCX extraction runtime is not loaded');
    const zip = await globalScope.JSZip.loadAsync(arrayBuffer);
    const candidateFiles = [
      'word/document.xml',
      'word/header1.xml',
      'word/header2.xml',
      'word/footer1.xml',
      'word/footer2.xml',
      'word/footnotes.xml',
      'word/endnotes.xml'
    ];

    const sections = [];
    for (const path of candidateFiles) {
      if (!zip.file(path)) continue;
      const text = extractXmlText(await readZipText(zip, path));
      if (text) {
        sections.push(text);
      }
    }

    if (sections.length === 0) {
      throw new Error('No readable DOCX content found');
    }

    return cleanText(sections.join('\n\n'));
  }

  function extractSpreadsheetText(arrayBuffer, fileName) {
    const workbook = globalScope.XLSX.read(arrayBuffer, {
      type: 'array',
      dense: true,
      cellFormula: false,
      cellHTML: false
    });

    const sections = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const text = globalScope.XLSX.utils.sheet_to_csv(sheet, {
        FS: '\t',
        RS: '\n',
        blankrows: false
      });
      return `Sheet: ${sheetName}\n${text}`.trim();
    }).filter(Boolean);

    if (sections.length === 0) {
      throw new Error(`No readable spreadsheet content found in ${fileName || 'spreadsheet'}`);
    }

    return cleanText(sections.join('\n\n'));
  }

  async function extractPresentationText(arrayBuffer, extension) {
    const zip = await globalScope.JSZip.loadAsync(arrayBuffer);
    if (extension === 'odp') {
      const contentXml = await readZipText(zip, 'content.xml');
      return cleanText(extractXmlText(contentXml));
    }

    const slideFiles = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(compareNumberedPaths);

    const sections = [];
    for (const slidePath of slideFiles) {
      const slideText = extractXmlText(await readZipText(zip, slidePath));
      if (slideText) {
        sections.push(`Slide ${extractTrailingNumber(slidePath)}\n${slideText}`.trim());
      }

      const notePath = `ppt/notesSlides/notesSlide${extractTrailingNumber(slidePath)}.xml`;
      if (zip.file(notePath)) {
        const notesText = extractXmlText(await readZipText(zip, notePath));
        if (notesText) {
          sections.push(`Slide ${extractTrailingNumber(slidePath)} Notes\n${notesText}`.trim());
        }
      }
    }

    if (sections.length === 0) {
      throw new Error('No readable slide text found in presentation');
    }

    return cleanText(sections.join('\n\n'));
  }

  async function extractOpenDocumentText(arrayBuffer) {
    const zip = await globalScope.JSZip.loadAsync(arrayBuffer);
    const contentXml = await readZipText(zip, 'content.xml');
    const text = extractXmlText(contentXml);
    if (!text) {
      throw new Error('No readable OpenDocument content found');
    }
    return cleanText(text);
  }

  async function extractEpubText(arrayBuffer) {
    const zip = await globalScope.JSZip.loadAsync(arrayBuffer);
    const contentFiles = Object.keys(zip.files)
      .filter(name => /\.(xhtml|html|htm|xml|ncx|opf)$/i.test(name))
      .sort(compareNumberedPaths);

    const sections = [];
    for (const path of contentFiles) {
      const rawText = await readZipText(zip, path);
      const text = extractMarkupText(rawText);
      if (text) {
        sections.push(text);
      }
    }

    if (sections.length === 0) {
      throw new Error('No readable EPUB content found');
    }

    return cleanText(sections.join('\n\n'));
  }

  async function extractGenericZipText(arrayBuffer, fileName) {
    const zip = await globalScope.JSZip.loadAsync(arrayBuffer);
    const textFiles = Object.keys(zip.files)
      .filter(name => /\.(xml|json|txt|md|csv|tsv|html|htm|xhtml|yaml|yml|toml|ini)$/i.test(name))
      .sort(compareNumberedPaths)
      .slice(0, 100);

    const sections = [];
    for (const path of textFiles) {
      const rawText = await readZipText(zip, path);
      const text = /\.(html?|xhtml|xml)$/i.test(path) ? extractMarkupText(rawText) : rawText;
      if (text) {
        sections.push(`File: ${path}\n${text}`.trim());
      }
    }

    if (sections.length === 0) {
      throw new Error(`No readable text entries found in ${fileName || 'archive'}`);
    }

    return cleanText(sections.join('\n\n'));
  }

  function extractMarkupText(rawText) {
    if (!rawText) return '';
    return /<[^>]+>/.test(rawText) ? extractXmlText(rawText) : rawText;
  }

  function extractXmlText(xmlText) {
    if (!xmlText) return '';

    if (typeof globalScope.DOMParser === 'function') {
      try {
        const doc = new globalScope.DOMParser().parseFromString(xmlText, 'application/xml');
        const parserError = doc.getElementsByTagName('parsererror');
        if (parserError?.length) {
          return cleanText(fallbackTagStrip(xmlText));
        }

        const blocks = [];
        const blockNames = new Set(['p', 'h', 'li', 'title', 'subtitle', 'text-box', 'div']);
        const blockNodes = doc.getElementsByTagName('*');
        for (const node of blockNodes) {
          if (!blockNames.has(String(node.localName || '').toLowerCase())) continue;
          const text = cleanText(node.textContent || '');
          if (text) {
            blocks.push(text);
          }
        }

        if (blocks.length > 0) {
          return cleanText(blocks.join('\n'));
        }

        return cleanText(doc.documentElement?.textContent || fallbackTagStrip(xmlText));
      } catch {
        return cleanText(fallbackTagStrip(xmlText));
      }
    }

    return cleanText(fallbackTagStrip(xmlText));
  }

  function fallbackTagStrip(text) {
    return String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  function stripRtf(text) {
    return String(text || '')
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\tab/g, '\t')
      .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
      .replace(/\\[a-z]+-?\d* ?/g, ' ')
      .replace(/[{}]/g, ' ');
  }

  async function readZipText(zip, path) {
    const entry = zip.file(path);
    return entry ? entry.async('string') : '';
  }

  function compareNumberedPaths(a, b) {
    const aNum = extractTrailingNumber(a);
    const bNum = extractTrailingNumber(b);
    if (aNum !== bNum) return aNum - bNum;
    return String(a).localeCompare(String(b));
  }

  function extractTrailingNumber(path) {
    const match = String(path || '').match(/(\d+)(?!.*\d)/);
    return match ? Number(match[1]) : 0;
  }

  function isTextLike(extension, mimeType) {
    return TEXT_EXTENSIONS.has(extension) ||
      mimeType.includes('text/') ||
      mimeType.includes('javascript') ||
      mimeType.includes('json') ||
      mimeType === 'application/xml' ||
      mimeType === 'text/xml' ||
      mimeType.endsWith('+xml') ||
      mimeType.includes('yaml') ||
      mimeType.includes('csv') ||
      mimeType === '';
  }

  function isPdf(extension, mimeType) {
    return extension === 'pdf' || mimeType.includes('pdf');
  }

  function isDocx(extension, mimeType) {
    return extension === 'docx' ||
      mimeType.includes('officedocument.wordprocessingml.document') ||
      mimeType.includes('docx');
  }

  function isPresentationMime(mimeType) {
    return mimeType.includes('presentationml') || mimeType.includes('powerpoint');
  }

  function isOdtMime(mimeType) {
    return mimeType.includes('opendocument.text');
  }

  function getExtension(fileName) {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/i);
    return match ? match[1] : '';
  }

  function requireRuntime(value, message) {
    if (!value) {
      throw new Error(message);
    }
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  globalScope.ChatUcyDocumentParser = {
    extractText
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
