// Page numbers start at 1.
export function pageOf(list, page, size) {
  const start = page * size;
  return list.slice(start, start + size);
}
