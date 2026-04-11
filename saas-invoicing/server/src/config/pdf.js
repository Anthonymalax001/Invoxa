const PDFDocument = require('pdfkit')

const generateInvoicePDF = (invoice, items, tenant) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 })
    const buffers = []

    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    // ── Header ──────────────────────────────────────────
    doc
      .fontSize(28)
      .fillColor('#2563eb')
      .font('Helvetica-Bold')
      .text('INVOXA', 50, 50)

    doc
      .fontSize(10)
      .fillColor('#6b7280')
      .font('Helvetica')
      .text(tenant.name, 50, 85)
      .text(tenant.email || '', 50, 100)
      .text(tenant.phone || '', 50, 115)

    // Invoice title on right
    doc
      .fontSize(20)
      .fillColor('#111827')
      .font('Helvetica-Bold')
      .text('INVOICE', 400, 50, { align: 'right' })

    doc
      .fontSize(10)
      .fillColor('#6b7280')
      .font('Helvetica')
      .text(`Invoice #: ${invoice.invoice_number}`, 400, 80, { align: 'right' })
      .text(`Date: ${new Date(invoice.created_at).toLocaleDateString()}`, 400, 95, { align: 'right' })
      .text(`Due: ${invoice.due_date ? new Date(invoice.due_date).toLocaleDateString() : 'N/A'}`, 400, 110, { align: 'right' })

    // Status badge
    const statusColors = {
      paid: '#16a34a',
      sent: '#2563eb',
      overdue: '#dc2626',
      draft: '#6b7280'
    }
    const statusColor = statusColors[invoice.status] || '#6b7280'
    doc
      .fontSize(10)
      .fillColor(statusColor)
      .font('Helvetica-Bold')
      .text(invoice.status.toUpperCase(), 400, 125, { align: 'right' })

    // ── Divider ──────────────────────────────────────────
    doc
      .moveTo(50, 145)
      .lineTo(545, 145)
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .stroke()

    // ── Bill To ──────────────────────────────────────────
    doc
      .fontSize(10)
      .fillColor('#6b7280')
      .font('Helvetica-Bold')
      .text('BILL TO', 50, 165)

    doc
      .fontSize(12)
      .fillColor('#111827')
      .font('Helvetica-Bold')
      .text(invoice.client_name, 50, 182)

    doc
      .fontSize(10)
      .fillColor('#6b7280')
      .font('Helvetica')
      .text(invoice.client_email || '', 50, 198)
      .text(invoice.client_phone || '', 50, 213)
      .text(invoice.client_address || '', 50, 228)

    // ── Items Table ──────────────────────────────────────
    const tableTop = 270

    // Table header background
    doc
      .rect(50, tableTop, 495, 25)
      .fillColor('#f3f4f6')
      .fill()

    // Table headers
    doc
      .fontSize(10)
      .fillColor('#374151')
      .font('Helvetica-Bold')
      .text('Description', 60, tableTop + 8)
      .text('Qty', 340, tableTop + 8, { width: 50, align: 'right' })
      .text('Unit Price', 390, tableTop + 8, { width: 80, align: 'right' })
      .text('Amount', 470, tableTop + 8, { width: 70, align: 'right' })

    // Table rows
    let y = tableTop + 35
    items.forEach((item, index) => {
      if (index % 2 === 0) {
        doc
          .rect(50, y - 8, 495, 25)
          .fillColor('#fafafa')
          .fill()
      }

      doc
        .fontSize(10)
        .fillColor('#111827')
        .font('Helvetica')
        .text(item.description, 60, y)
        .text(item.quantity.toString(), 340, y, { width: 50, align: 'right' })
        .text(`KES ${parseFloat(item.unit_price).toLocaleString()}`, 390, y, { width: 80, align: 'right' })
        .text(`KES ${parseFloat(item.amount).toLocaleString()}`, 470, y, { width: 70, align: 'right' })

      y += 30
    })

    // ── Totals ───────────────────────────────────────────
    const totalsY = y + 20

    doc
      .moveTo(350, totalsY - 10)
      .lineTo(545, totalsY - 10)
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .stroke()

    doc
      .fontSize(10)
      .fillColor('#6b7280')
      .font('Helvetica')
      .text('Subtotal:', 350, totalsY)
      .text(`KES ${parseFloat(invoice.subtotal).toLocaleString()}`, 470, totalsY, { width: 70, align: 'right' })

    doc
      .text(`VAT (${invoice.tax_rate}%):`, 350, totalsY + 20)
      .text(`KES ${parseFloat(invoice.tax_amount).toLocaleString()}`, 470, totalsY + 20, { width: 70, align: 'right' })

    // Total row
    doc
      .rect(350, totalsY + 40, 195, 28)
      .fillColor('#2563eb')
      .fill()

    doc
      .fontSize(11)
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .text('TOTAL:', 360, totalsY + 49)
      .text(`KES ${parseFloat(invoice.total).toLocaleString()}`, 470, totalsY + 49, { width: 70, align: 'right' })

    // ── Notes ────────────────────────────────────────────
    if (invoice.notes) {
      doc
        .moveTo(50, totalsY + 85)
        .lineTo(545, totalsY + 85)
        .strokeColor('#e5e7eb')
        .lineWidth(1)
        .stroke()

      doc
        .fontSize(10)
        .fillColor('#6b7280')
        .font('Helvetica-Bold')
        .text('NOTES', 50, totalsY + 100)

      doc
        .fontSize(10)
        .fillColor('#374151')
        .font('Helvetica')
        .text(invoice.notes, 50, totalsY + 116, { width: 495 })
    }

    // ── Footer ───────────────────────────────────────────
    doc
      .fontSize(9)
      .fillColor('#9ca3af')
      .font('Helvetica')
      .text('Thank you for your business!', 50, 720, { align: 'center', width: 495 })
      .text('Generated by Invoxa', 50, 735, { align: 'center', width: 495 })

    doc.end()
  })
}

module.exports = { generateInvoicePDF }