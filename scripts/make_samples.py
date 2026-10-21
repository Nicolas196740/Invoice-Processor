"""
Builds the 3 sample invoices in public/samples/ (served at /samples/...).

They imitate the LAYOUT of the restaurant's real vendors, but every number, address and name detail
is made up: no real bank, routing, customer numbers or signatures. Each PDF is marked as a sample.
All math is done in whole cents, and the script stops if any total doesn't add up exactly.

Run:  python3 scripts/make_samples.py
"""
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import black, HexColor

OUT = Path(__file__).resolve().parent.parent / 'public' / 'samples'
W, H = letter
GREY = HexColor('#666666')
LINE = HexColor('#999999')
TAX = 0.07  # sample sales tax rate on non-food items


def money(c):
    return f'{c // 100:,}.{c % 100:02d}'


def cents(x):
    return round(x * 100)


def tax_on(c):
    return int(c * TAX + 0.5)  # round half up to the cent


def sample_marks(c, page, pages):
    # A banner + footer (not a diagonal watermark: its letters would mix into the PDF's text and confuse the AI read).
    c.setFillColor(HexColor('#c8102e'))
    c.setFont('Helvetica-Bold', 8)
    c.drawCentredString(W / 2, H - 22, 'SAMPLE INVOICE · FAKE NUMBERS · FOR A CLASS PROJECT DEMO')
    c.setFont('Helvetica', 7.5)
    c.setFillColor(GREY)
    c.drawCentredString(W / 2, 28, 'SAMPLE INVOICE for an FAU class project (ISM4421). Not a real invoice: all numbers, '
                                   'names and addresses are made up.')
    c.drawRightString(W - 40, 40, f'Page {page} of {pages}')
    c.setFillColor(black)


def table(c, x, y, cols, rows, widths, aligns, size=8.5, lead=14, bold_header=True):
    c.setFont('Helvetica-Bold' if bold_header else 'Helvetica', size)
    cx = x
    for i, h in enumerate(cols):
        draw(c, cx, y, widths[i], h, aligns[i])
        cx += widths[i]
    y -= 4
    c.setStrokeColor(LINE)
    c.line(x, y, x + sum(widths), y)
    y -= lead - 2
    c.setFont('Helvetica', size)
    for r in rows:
        cx = x
        for i, v in enumerate(r):
            draw(c, cx, y, widths[i], str(v), aligns[i])
            cx += widths[i]
        y -= lead
    return y


def draw(c, x, y, w, text, align):
    if align == 'r':
        c.drawRightString(x + w - 4, y, text)
    elif align == 'c':
        c.drawCentredString(x + w / 2, y, text)
    else:
        c.drawString(x + 2, y, text)


def label_value(c, x, y, pairs, size=9, gap=13):
    for k, v in pairs:
        c.setFont('Helvetica-Bold', size)
        c.drawString(x, y, k)
        c.setFont('Helvetica', size)
        c.drawString(x + 92, y, v)
        y -= gap
    return y


# ───────────────────────── a) GFS-style, 2 pages, Group Summary on the last page ─────────────────────────
def gfs():
    number, date, due = '9041587206', '10/20/2026', '10/30/2026'
    # (item #, description, pack/size, qty, unit price, group, taxable)
    items = [
        ('118702', 'ANCHOVY FLLT IN OLIVE OIL', '12/28 OZ', 1, 38.42, 'Seafood', False),
        ('402315', 'SAUCE PIZZA FCY W/BASIL', '6/#10', 4, 31.85, 'Grocery', False),
        ('556120', 'OIL OLIVE EXTRA VIRGIN', '6/3 LTR', 2, 41.20, 'Grocery', False),
        ('612044', 'BASIL FRESH', '1 LB', 2, 14.75, 'Produce', False),
        ('600118', 'ONION YELLOW JUMBO', '50 LB', 1, 32.10, 'Produce', False),
        ('600731', 'PEPPER GREEN BELL CHOICE', '1-1/9 BU', 1, 28.64, 'Produce', False),
        ('733905', 'CRUST PIZZA GLUTEN FREE 12IN', '24/7 OZ', 2, 46.90, 'Frozen', False),
        ('803461', 'CHEESE MOZZ WHL MLK SHRD', '4/5 LB', 6, 52.35, 'Dairy', False),
        ('801278', 'CHEESE PARM GRATED', '2/5 LB', 1, 48.60, 'Dairy', False),
        ('905512', 'BOX PIZZA 14IN KRAFT', '50 CT', 3, 28.40, 'Disposables', True),
        ('907788', 'CUP PORTION 2 OZ PLAS', '2500 CT', 1, 36.15, 'Disposables', True),
        ('951203', 'DEGREASER HEAVY DUTY', '4/1 GAL', 1, 34.80, 'Chemical', True),
        ('951940', 'SANITIZER QUAT', '4/1 GAL', 1, 41.25, 'Chemical', True),
        ('980045', 'SODA COLA CAN', '24/12 OZ', 3, 13.95, 'Beverage', True),
        ('980310', 'WATER SPRING BTL', '24/16.9 OZ', 2, 5.48, 'Beverage', False),
    ]
    fuel = cents(6.95)
    groups = ['Seafood', 'Grocery', 'Produce', 'Frozen', 'Dairy', 'Disposables', 'Chemical', 'Beverage']
    summary = []  # (group, pieces, amount, tax, total) in cents
    for g in groups:
        rows = [i for i in items if i[5] == g]
        amount = sum(i[3] * cents(i[4]) for i in rows)
        tax = sum(tax_on(i[3] * cents(i[4])) for i in rows if i[6])
        summary.append((g, sum(i[3] for i in rows), amount, tax, amount + tax))
    summary.append(('Fuel Charge', 0, fuel, 0, fuel))
    total = sum(s[4] for s in summary)

    c = canvas.Canvas(str(OUT / 'sample-gfs-9041587206.pdf'), pagesize=letter)
    c.setTitle('SAMPLE GFS-style invoice 9041587206')
    for page in (1, 2):
        sample_marks(c, page, 2)
        c.setFont('Helvetica-Bold', 15)
        c.drawString(40, H - 50, 'Gordon Food Service')
        c.setFont('Helvetica', 8.5)
        c.drawString(40, H - 63, 'SAMPLE distribution center · 100 Example Way · Sampletown, FL 00000')
        c.setFont('Helvetica-Bold', 13)
        c.drawRightString(W - 40, H - 50, 'INVOICE')
        label_value(c, W - 220, H - 68, [('Invoice #', number), ('Invoice Date', date), ('Due Date', due),
                                         ('Customer #', 'SAMPLE-0001'), ('Terms', 'NET 10')])
        if page == 1:
            label_value(c, 40, H - 95, [('Ship To', 'Mister O1 (sample)'), ('', '123 Sample St'), ('', 'Boca Raton, FL 00000')])
            rows = [(i[0], i[1], i[2], i[3], money(cents(i[4])), money(i[3] * cents(i[4])), 'T' if i[6] else '', i[5])
                    for i in items]
            table(c, 40, H - 160, ['Item #', 'Description', 'Pack/Size', 'Qty', 'Unit Price', 'Ext Price', 'Tax', 'Group'],
                  rows, [48, 160, 62, 30, 58, 62, 26, 86], ['l', 'l', 'l', 'r', 'r', 'r', 'c', 'l'])
            c.setFont('Helvetica-Oblique', 8.5)
            c.drawString(40, 90, 'Continued on next page. Group Summary and invoice total on page 2.')
        else:
            c.setFont('Helvetica-Bold', 11)
            c.drawString(40, H - 160, 'Group Summary')
            rows = [(s[0], s[1] or '', money(s[2]), money(s[3]), money(s[4])) for s in summary]
            y = table(c, 40, H - 180, ['Group', 'Pieces', 'Amount', 'Tax', 'Total'], rows,
                      [170, 60, 90, 70, 90], ['l', 'r', 'r', 'r', 'r'], size=9.5, lead=16)
            c.setStrokeColor(black)
            c.line(40, y + 10, 520, y + 10)
            c.setFont('Helvetica-Bold', 9.5)
            draw(c, 40, y - 4, 170, 'Total', 'l')
            draw(c, 270, y - 4, 90, money(sum(s[2] for s in summary)), 'r')
            draw(c, 360, y - 4, 70, money(sum(s[3] for s in summary)), 'r')
            draw(c, 430, y - 4, 90, money(total), 'r')
            c.setFont('Helvetica-Bold', 13)
            c.drawRightString(W - 40, y - 50, 'AMOUNT DUE  $' + money(total))
        c.showPage()
    c.save()
    expected = {
        'Other food': summary[0][4] + summary[1][4], 'Produce': summary[2][4], 'Dough': summary[3][4],
        'Dairy': summary[4][4], 'Paper & Packaging': summary[5][4], 'Janitorial & Cleaning Supplies': summary[6][4],
        'Beverage': summary[7][4], 'Restaurant Expense': summary[8][4],
    }
    return 'GFS', number, '2026-10-20', expected, total, summary


# ───────────────────────── b) Warehouse-style dough invoice "CO - 004512" ─────────────────────────
def warehouse():
    number, date = 'CO - 004512', '10/21/2026'
    items = [('DB16', 'PIZZA DOUGH BALL 16 OZ (24/CS)', 30, 38.50),
             ('DB10', 'PIZZA DOUGH BALL 10 OZ (36/CS)', 4, 41.25)]
    total = sum(q * cents(p) for _, _, q, p in items)
    c = canvas.Canvas(str(OUT / 'sample-warehouse-CO-004512.pdf'), pagesize=letter)
    c.setTitle('SAMPLE Warehouse-style invoice CO - 004512')
    sample_marks(c, 1, 1)
    c.setFont('Helvetica-Bold', 18)
    c.drawString(40, H - 55, 'WAREHOUSE 305')
    c.setFont('Helvetica', 9)
    c.drawString(40, H - 69, 'Artisan Dough & Bakery (sample) · 200 Example Ave · Sampletown, FL 00000')
    c.setFont('Helvetica-Bold', 13)
    c.drawRightString(W - 40, H - 55, 'INVOICE')
    label_value(c, W - 220, H - 75, [('Invoice No.', number), ('Date', date), ('Terms', 'Due on receipt')])
    label_value(c, 40, H - 105, [('Bill To', 'Mister O1 (sample)'), ('', '123 Sample St, Boca Raton, FL 00000')])
    rows = [(code, d, q, money(cents(p)), money(q * cents(p))) for code, d, q, p in items]
    y = table(c, 40, H - 160, ['Code', 'Description', 'Qty', 'Price', 'Amount'], rows,
              [60, 250, 50, 80, 92], ['l', 'l', 'r', 'r', 'r'], size=10, lead=18)
    y -= 10
    label_value(c, W - 220, y, [('Subtotal', '$' + money(total)), ('Sales tax', '$0.00'), ('TOTAL', '$' + money(total))], size=10, gap=15)
    c.setFont('Helvetica-Oblique', 9)
    c.drawString(40, 90, 'Received by: ____________________ (sample)')
    c.showPage()
    c.save()
    return 'Warehouse', '004512', '2026-10-21', {'Dough': total}, total, None


# ───────────────────────── c) Tita-style wine invoice ─────────────────────────
def tita():
    number, date, due = '11873', '10/19/2026', '11/03/2026'
    items = [('Chianti Classico DOCG 2022', '750 ml', 12, 14.50),
             ("Montepulciano d'Abruzzo 2023", '750 ml', 12, 11.25),
             ('Pinot Grigio delle Venezie 2024', '750 ml', 6, 12.80)]
    total = sum(q * cents(p) for _, _, q, p in items)
    c = canvas.Canvas(str(OUT / 'sample-tita-11873.pdf'), pagesize=letter)
    c.setTitle('SAMPLE Tita-style wine invoice 11873')
    sample_marks(c, 1, 1)
    c.setFont('Times-Bold', 22)
    c.drawString(40, H - 58, 'Tita')
    c.setFont('Times-Italic', 11)
    c.drawString(40, H - 73, 'Italian Wines & Imports (sample)')
    c.setFont('Helvetica', 8.5)
    c.drawString(40, H - 86, '300 Example Blvd · Sampletown, FL 00000')
    c.setFont('Helvetica-Bold', 13)
    c.drawRightString(W - 40, H - 58, 'INVOICE')
    label_value(c, W - 220, H - 78, [('Invoice #', number), ('Invoice Date', date), ('Due Date', due), ('Terms', 'Net 15')])
    label_value(c, 40, H - 115, [('Sold To', 'Mister O1 (sample)'), ('', '123 Sample St, Boca Raton, FL 00000')])
    rows = [(d, s, q, money(cents(p)), money(q * cents(p))) for d, s, q, p in items]
    y = table(c, 40, H - 170, ['Wine', 'Size', 'Bottles', 'Price/btl', 'Amount'], rows,
              [230, 60, 60, 80, 102], ['l', 'l', 'r', 'r', 'r'], size=10, lead=18)
    y -= 10
    label_value(c, W - 220, y, [('Subtotal', '$' + money(total)), ('Sales tax', '$0.00 (resale)'), ('TOTAL DUE', '$' + money(total))], size=10, gap=15)
    c.showPage()
    c.save()
    return 'Tita', number, '2026-10-19', {'Beverage': total}, total, None


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for make in (gfs, warehouse, tita):
        vendor, number, date, expected, total, summary = make()
        assert sum(expected.values()) == total, (vendor, expected, total)
        if summary:
            assert sum(s[4] for s in summary) == total
            for s in summary:
                print(f'   GFS group {s[0]:<12} amount {money(s[2]):>8}  tax {money(s[3]):>6}  total {money(s[4]):>8}')
        print(f'{vendor:<10} #{number:<11} {date}  total {money(total):>9}  ' +
              ', '.join(f'{k} {money(v)}' for k, v in expected.items()))
