// Loads every id with the given fetcher, keeping the order of ids.
export async function loadAll(ids, fetchOne) {
  return ids.map(async (id) => ({ id, value: await fetchOne(id) }));
}
