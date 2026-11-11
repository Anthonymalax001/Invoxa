function csvCell(value, numeric) {
  let text = value == null ? '' : String(value)
  if (!numeric && /^[\s]*[=+\-@]/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}

export function createFinancialReportCsv(columns, rows) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new TypeError('CSV columns and rows must be arrays')
  }
  const lines = [columns.map((column) => csvCell(column.label, false)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key], column.type === 'number')).join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}
