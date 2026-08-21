// O PostgREST limita cada resposta a 1000 linhas por padrao e trunca em silencio:
// nao ha erro nem aviso, a query simplesmente devolve menos do que existe.
// Toda leitura que possa passar desse volume precisa paginar por .range().
const PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows;
}
