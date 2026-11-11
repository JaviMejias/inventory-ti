import { apiRequest, ApiRequestError } from './api';

export function mergeRecords<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const records = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) records.set(item.id, item);
  return [...records.values()];
}

export async function fetchAllPages<T, R extends { hasMore: boolean }>(
  path: string,
  records: (response: R) => T[],
  options: globalThis.RequestInit = {}
): Promise<T[]> {
  const [pathname, query] = path.split('?');
  const params = new globalThis.URLSearchParams(query);
  params.set('limit', '100');
  const items: T[] = [];
  do {
    params.set('offset', String(items.length));
    const response = await apiRequest<R>(`${pathname}?${params}`, options);
    const page = records(response);
    if (response.hasMore && !page.length) throw new ApiRequestError('Invalid pagination response', 200, 'INVALID_RESPONSE');
    items.push(...page);
    if (!response.hasMore) return items;
  } while (!options.signal?.aborted);
  throw options.signal?.reason ?? new Error('Request aborted');
}
