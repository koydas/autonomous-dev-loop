// Small stock helpers.
export function itemName(items, id) {
  return items.find((item) => item.id === id).name;
}
