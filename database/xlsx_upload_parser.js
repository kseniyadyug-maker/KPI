const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeZipPath(entryPath) {
  return String(entryPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function decodeXmlText(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(source) {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(source);
  while (match) {
    attributes[match[1]] = decodeXmlText(match[2]);
    match = pattern.exec(source);
  }
  return attributes;
}

function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }

  throw new Error('Invalid .xlsx file: end of central directory not found.');
}

function parseZipEntries(buffer) {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const entries = new Map();

  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Invalid .xlsx file: bad central directory record.');
    }

    const generalPurposeFlag = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameBuffer = buffer.subarray(offset + 46, offset + 46 + fileNameLength);
    const fileName = normalizeZipPath(
      fileNameBuffer.toString((generalPurposeFlag & 0x0800) !== 0 ? 'utf8' : 'latin1')
    );

    entries.set(fileName, {
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function inflateZipEntry(buffer, entry) {
  const localHeaderOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('Invalid .xlsx file: bad local file header.');
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressedData = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData;
  }

  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressedData);
  }

  throw new Error(`Unsupported .xlsx compression method: ${entry.compressionMethod}`);
}

function readZipEntryText(zipEntries, zipBuffer, entryPath) {
  const candidates = [
    normalizeZipPath(entryPath),
    normalizeZipPath(String(entryPath ?? '').replace(/\//g, '\\')),
    normalizeZipPath(String(entryPath ?? '').replace(/\\/g, '/')),
  ];

  for (const candidate of candidates) {
    const entry = zipEntries.get(candidate);
    if (!entry) {
      continue;
    }

    return stripBom(inflateZipEntry(zipBuffer, entry).toString('utf8'));
  }

  return null;
}

function resolveWorkbookSheetPath(target) {
  const normalizedTarget = normalizeZipPath(target);
  if (!normalizedTarget) {
    return '';
  }

  if (normalizedTarget.startsWith('xl/')) {
    return normalizedTarget;
  }

  return path.posix.normalize(`xl/${normalizedTarget}`);
}

function parseWorkbookSheets(zipEntries, zipBuffer) {
  const workbookXml = readZipEntryText(zipEntries, zipBuffer, 'xl/workbook.xml');
  const relationshipsXml = readZipEntryText(zipEntries, zipBuffer, 'xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) {
    throw new Error('Invalid .xlsx file: workbook metadata not found.');
  }

  const relationshipMap = new Map();
  const relationshipPattern = /<Relationship\b([^>]*?)\/>/g;
  let relationshipMatch = relationshipPattern.exec(relationshipsXml);
  while (relationshipMatch) {
    const attributes = parseXmlAttributes(relationshipMatch[1]);
    if (attributes.Id && attributes.Target) {
      relationshipMap.set(attributes.Id, resolveWorkbookSheetPath(attributes.Target));
    }
    relationshipMatch = relationshipPattern.exec(relationshipsXml);
  }

  const sheets = [];
  const sheetPattern = /<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/g;
  let sheetMatch = sheetPattern.exec(workbookXml);
  while (sheetMatch) {
    const attributes = parseXmlAttributes(sheetMatch[1]);
    const relId = attributes['r:id'] || attributes.id;
    const target = relationshipMap.get(relId);
    if (attributes.name && target) {
      sheets.push({
        name: attributes.name,
        path: target,
      });
    }
    sheetMatch = sheetPattern.exec(workbookXml);
  }

  return sheets;
}

function parseSharedStrings(zipEntries, zipBuffer) {
  const sharedStringsXml = readZipEntryText(zipEntries, zipBuffer, 'xl/sharedStrings.xml');
  if (!sharedStringsXml) {
    return [];
  }

  const sharedStrings = [];
  const stringItemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let stringItemMatch = stringItemPattern.exec(sharedStringsXml);
  while (stringItemMatch) {
    const stringParts = [];
    const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch = textPattern.exec(stringItemMatch[1]);
    while (textMatch) {
      stringParts.push(decodeXmlText(textMatch[1]));
      textMatch = textPattern.exec(stringItemMatch[1]);
    }
    sharedStrings.push(stringParts.join(''));
    stringItemMatch = stringItemPattern.exec(sharedStringsXml);
  }

  return sharedStrings;
}

function getCellColumn(cellReference) {
  return String(cellReference ?? '').replace(/\d/g, '');
}

function extractInlineText(xmlFragment) {
  const parts = [];
  const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let textMatch = textPattern.exec(xmlFragment);
  while (textMatch) {
    parts.push(decodeXmlText(textMatch[1]));
    textMatch = textPattern.exec(xmlFragment);
  }
  return parts.join('');
}

function getCellValue(cellAttributes, cellInnerXml, sharedStrings) {
  const cellType = cellAttributes.t || '';
  if (cellType === 'inlineStr') {
    return extractInlineText(cellInnerXml);
  }

  const valueMatch = cellInnerXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  if (!valueMatch) {
    return extractInlineText(cellInnerXml);
  }

  const rawValue = decodeXmlText(valueMatch[1]);
  if (cellType === 's') {
    const sharedStringIndex = Number.parseInt(rawValue, 10);
    if (Number.isInteger(sharedStringIndex) && sharedStringIndex >= 0 && sharedStringIndex < sharedStrings.length) {
      return sharedStrings[sharedStringIndex];
    }
    return '';
  }

  return rawValue;
}

function parseSheetRows(zipEntries, zipBuffer, sheetPath, sharedStrings) {
  const sheetXml = readZipEntryText(zipEntries, zipBuffer, sheetPath);
  if (!sheetXml) {
    return [];
  }

  const rows = [];
  const rowPattern = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch = rowPattern.exec(sheetXml);
  while (rowMatch) {
    const rowAttributes = parseXmlAttributes(rowMatch[1]);
    const rowNumber = Number.parseInt(rowAttributes.r || '0', 10);
    const cells = {};
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch = cellPattern.exec(rowMatch[2]);
    while (cellMatch) {
      const cellAttributes = parseXmlAttributes(cellMatch[1]);
      const column = getCellColumn(cellAttributes.r);
      if (column) {
        cells[column] = getCellValue(cellAttributes, cellMatch[2] || '', sharedStrings);
      }
      cellMatch = cellPattern.exec(rowMatch[2]);
    }

    rows.push({
      rowNumber: Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : rows.length + 1,
      cells,
    });
    rowMatch = rowPattern.exec(sheetXml);
  }

  return rows;
}

function getCellText(cells, column) {
  return Object.prototype.hasOwnProperty.call(cells, column) ? String(cells[column] ?? '') : '';
}

function isNumericLikeValue(value) {
  const normalizedValue = normalizeText(value).replaceAll('%', '').replaceAll(',', '.');
  if (!normalizedValue) {
    return false;
  }

  return Number.isFinite(Number(normalizedValue));
}

function getPreviewScore(rows, headerRowNumber, nameColumn, resultColumn) {
  let score = 0;

  for (const row of rows) {
    if (row.rowNumber <= headerRowNumber) {
      continue;
    }
    if (score >= 90) {
      break;
    }

    const fullName = normalizeText(getCellText(row.cells, nameColumn));
    const resultValue = normalizeText(getCellText(row.cells, resultColumn));
    if (!fullName && !resultValue) {
      continue;
    }

    if (fullName) {
      score += 1;
    }
    if (isNumericLikeValue(resultValue)) {
      score += 2;
    }
  }

  return score;
}

function findUploadColumns(rows, options) {
  const rowScanLimit = options.rowScanLimit ?? 30;
  let bestCandidate = null;

  for (const row of rows.slice(0, rowScanLimit)) {
    let nameCandidate = '';
    let resultCandidate = '';
    let bestNameScore = -100;
    let bestResultScore = -100;

    for (const [column, rawValue] of Object.entries(row.cells)) {
      const text = normalizeText(rawValue);
      const nameScore = options.getNameColumnScore(text);
      const resultScore = options.getResultColumnScore(text);

      if (nameScore > bestNameScore) {
        bestNameScore = nameScore;
        nameCandidate = column;
      }
      if (resultScore > bestResultScore) {
        bestResultScore = resultScore;
        resultCandidate = column;
      }
    }

    if (!nameCandidate || !resultCandidate || bestNameScore <= 0 || bestResultScore <= 0) {
      continue;
    }

    const previewScore = getPreviewScore(rows, row.rowNumber, nameCandidate, resultCandidate);
    const totalScore = bestNameScore + bestResultScore + previewScore;

    if (!bestCandidate || totalScore > bestCandidate.score) {
      bestCandidate = {
        score: totalScore,
        headerRowNumber: row.rowNumber,
        fioColumn: nameCandidate,
        percentColumn: resultCandidate,
      };
    }
  }

  return bestCandidate;
}

function createExecutionDisciplineParserOptions() {
  return {
    rowScanLimit: 30,
    noColumnsError: 'FIO and percent columns were not found in the Excel file.',
    getNameColumnScore(text) {
      const normalizedText = normalizeText(text).toLowerCase();
      if (!normalizedText) {
        return -100;
      }

      let score = 0;
      if (normalizedText.includes('исполнитель')) {
        score += 12;
      }
      if (normalizedText.includes('сотрудник')) {
        score += 10;
      }
      if (normalizedText.includes('фио')) {
        score += 8;
      }
      if (normalizedText.includes('фамил')) {
        score += 6;
      }

      return score;
    },
    getResultColumnScore(text) {
      const normalizedText = normalizeText(text).toLowerCase();
      if (!normalizedText) {
        return -100;
      }

      let score = 0;
      if (normalizedText.includes('итого')) {
        score += 14;
      }
      if (normalizedText.includes('%')) {
        score += 8;
      }
      if (normalizedText.includes('процент')) {
        score += 5;
      }
      if (normalizedText.includes('kpi')) {
        score += 1;
      }
      if (normalizedText.includes('учитывать')) {
        score -= 20;
      }

      return score;
    },
  };
}

function createContractApprovalsParserOptions() {
  return {
    rowScanLimit: 20,
    noColumnsError: 'Employee and percent columns were not found in the Excel file.',
    getNameColumnScore(text) {
      const normalizedText = normalizeText(text).toLowerCase();
      if (!normalizedText) {
        return -100;
      }

      let score = 0;
      if (normalizedText.includes('сотрудник')) {
        score += 12;
      }
      if (normalizedText.includes('исполнитель')) {
        score += 10;
      }
      if (normalizedText.includes('фио')) {
        score += 8;
      }

      return score;
    },
    getResultColumnScore(text) {
      const normalizedText = normalizeText(text).toLowerCase();
      if (!normalizedText) {
        return -100;
      }

      let score = 0;
      if (normalizedText.includes('исполнение')) {
        score += 14;
      }
      if (normalizedText.includes('%')) {
        score += 8;
      }
      if (normalizedText.includes('процент')) {
        score += 5;
      }

      return score;
    },
  };
}

function parseWorkbookRows(workbookPath, options) {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  const zipBuffer = fs.readFileSync(workbookPath);
  const zipEntries = parseZipEntries(zipBuffer);
  const sharedStrings = parseSharedStrings(zipEntries, zipBuffer);
  const sheets = parseWorkbookSheets(zipEntries, zipBuffer);

  let bestSheetResult = null;

  for (const sheet of sheets) {
    const rows = parseSheetRows(zipEntries, zipBuffer, sheet.path, sharedStrings);
    const columns = findUploadColumns(rows, options);
    if (!columns) {
      continue;
    }

    const resultRows = [];
    for (const row of rows) {
      if (row.rowNumber <= columns.headerRowNumber) {
        continue;
      }

      const fullName = normalizeText(getCellText(row.cells, columns.fioColumn));
      const percent = normalizeText(getCellText(row.cells, columns.percentColumn));
      if (!fullName && !percent) {
        continue;
      }

      resultRows.push({
        fullName,
        percent,
      });
    }

    const sheetResult = {
      score: columns.score,
      sheetName: sheet.name,
      rows: resultRows,
    };

    if (!bestSheetResult || sheetResult.score > bestSheetResult.score) {
      bestSheetResult = sheetResult;
    }
  }

  if (!bestSheetResult) {
    throw new Error(options.noColumnsError);
  }

  return {
    sheetName: bestSheetResult.sheetName,
    rows: bestSheetResult.rows,
  };
}

function normalizeExportHeader(value) {
  return normalizeText(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[."«»()]/g, '');
}

function parseExportMonthHeader(value) {
  const normalizedValue = normalizeExportHeader(value);
  if (!normalizedValue) {
    return '';
  }

  const monthNumber = Number.parseInt(normalizedValue, 10);
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return '';
  }

  return String(monthNumber).padStart(2, '0');
}

function scoreExportHeaderColumn(text) {
  const normalizedText = normalizeExportHeader(text);
  if (!normalizedText) {
    return {};
  }

  if (normalizedText === 'id') {
    return { columnType: 'id', score: 12 };
  }
  if (normalizedText.includes('обект') || normalizedText.includes('объект')) {
    return { columnType: 'object', score: 12 };
  }
  if (normalizedText.includes('руковод')) {
    return { columnType: 'manager', score: 12 };
  }
  if (normalizedText === 'typ' || normalizedText === 'type') {
    return { columnType: 'type', score: 12 };
  }

  const monthCode = parseExportMonthHeader(text);
  if (monthCode) {
    return { columnType: 'month', score: 10, monthCode };
  }

  return {};
}

function findProjectManagerExportColumns(rows) {
  let bestCandidate = null;

  for (const row of rows.slice(0, 20)) {
    const candidate = {
      headerRowNumber: row.rowNumber,
      idColumn: '',
      objectColumn: '',
      managerColumn: '',
      typeColumn: '',
      monthColumns: {},
      score: 0,
    };

    for (const [column, rawValue] of Object.entries(row.cells)) {
      const scoredColumn = scoreExportHeaderColumn(rawValue);
      if (!scoredColumn.columnType || !Number.isFinite(scoredColumn.score)) {
        continue;
      }

      candidate.score += scoredColumn.score;
      if (scoredColumn.columnType === 'id') {
        candidate.idColumn = candidate.idColumn || column;
        continue;
      }
      if (scoredColumn.columnType === 'object') {
        candidate.objectColumn = candidate.objectColumn || column;
        continue;
      }
      if (scoredColumn.columnType === 'manager') {
        candidate.managerColumn = candidate.managerColumn || column;
        continue;
      }
      if (scoredColumn.columnType === 'type') {
        candidate.typeColumn = candidate.typeColumn || column;
        continue;
      }
      if (scoredColumn.columnType === 'month' && scoredColumn.monthCode) {
        candidate.monthColumns[scoredColumn.monthCode] = column;
      }
    }

    const monthCount = Object.keys(candidate.monthColumns).length;
    if (!candidate.idColumn || !candidate.objectColumn || !candidate.managerColumn || !candidate.typeColumn || monthCount < 12) {
      continue;
    }

    candidate.score += monthCount * 3;
    if (!bestCandidate || candidate.score > bestCandidate.score) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function parseProjectManagerExport(workbookPath) {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  const zipBuffer = fs.readFileSync(workbookPath);
  const zipEntries = parseZipEntries(zipBuffer);
  const sharedStrings = parseSharedStrings(zipEntries, zipBuffer);
  const sheets = parseWorkbookSheets(zipEntries, zipBuffer);

  let bestSheetResult = null;

  for (const sheet of sheets) {
    const rows = parseSheetRows(zipEntries, zipBuffer, sheet.path, sharedStrings);
    const columns = findProjectManagerExportColumns(rows);
    if (!columns) {
      continue;
    }

    const resultRows = [];
    for (const row of rows) {
      if (row.rowNumber <= columns.headerRowNumber) {
        continue;
      }

      const sourceId = normalizeText(getCellText(row.cells, columns.idColumn));
      const objectName = normalizeText(getCellText(row.cells, columns.objectColumn));
      const managerName = normalizeText(getCellText(row.cells, columns.managerColumn));
      const typeCode = normalizeText(getCellText(row.cells, columns.typeColumn)).toUpperCase();
      const monthValues = {};

      for (const [monthCode, column] of Object.entries(columns.monthColumns)) {
        monthValues[monthCode] = normalizeText(getCellText(row.cells, column));
      }

      const hasMonthValue = Object.values(monthValues).some((value) => value !== '');
      if (!sourceId && !objectName && !managerName && !typeCode && !hasMonthValue) {
        continue;
      }

      resultRows.push({
        sourceId,
        objectName,
        managerName,
        typeCode,
        monthValues,
      });
    }

    const sheetResult = {
      score: columns.score + resultRows.length,
      sheetName: sheet.name,
      rows: resultRows,
    };

    if (!bestSheetResult || sheetResult.score > bestSheetResult.score) {
      bestSheetResult = sheetResult;
    }
  }

  if (!bestSheetResult) {
    throw new Error('Object / manager / typ / month columns were not found in the Excel file.');
  }

  return {
    sheetName: bestSheetResult.sheetName,
    rows: bestSheetResult.rows,
  };
}

function parseExecutionDisciplineUpload(workbookPath) {
  return parseWorkbookRows(workbookPath, createExecutionDisciplineParserOptions());
}

function parseContractApprovalsUpload(workbookPath) {
  return parseWorkbookRows(workbookPath, createContractApprovalsParserOptions());
}

module.exports = {
  parseExecutionDisciplineUpload,
  parseContractApprovalsUpload,
  parseProjectManagerExport,
};
