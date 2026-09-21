// Compute the EXPECTED salesopendaily.DeliveryVia code for a Ticket invoice.
// Pickup orders are skipped (the D-codes only apply to deliveries).
//
// Rules (delivery orders only):
//   State NC:
//     - delivery date set, diff(delivery, order) > 2 days  -> D
//     - delivery date set, diff(delivery, order) <= 2 days -> D2
//     - delivery date not set (ASAP)                       -> D  (treated as >2)
//   State other than NC:
//     - delivery date set     -> D2
//     - delivery date not set -> D5

function diffDays(orderDate, deliveryDate) {
  if (!orderDate || !deliveryDate) return null;
  const t1 = Date.parse(orderDate);
  const t2 = Date.parse(deliveryDate);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}

function expectedDeliveryVia({ state, orderDate, deliveryDate, isPickup }) {
  if (isPickup) return null;

  const isNC = String(state || '').trim().toUpperCase() === 'NC';
  const ddate = String(deliveryDate || '').trim();
  const hasDate = ddate && ddate.toUpperCase() !== 'ASAP';

  if (isNC) {
    if (!hasDate) return 'D';
    const days = diffDays(orderDate, ddate);
    if (days === null) return null;
    return days > 2 ? 'D' : 'D2';
  }
  return hasDate ? 'D2' : 'D5';
}

module.exports = { expectedDeliveryVia, diffDays };
