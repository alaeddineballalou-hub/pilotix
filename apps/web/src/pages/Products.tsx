import { Language, Product } from '@pilotix/shared';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, SortingState, useReactTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Loading } from '../components/ui';
import { api } from '../lib/api';
import { formatDZD } from '../lib/i18n';

const col = createColumnHelper<Product>();
const LOW_STOCK = 10;

export function Products() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Language;
  const [q, setQ] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const query = useQuery({ queryKey: ['products', q], queryFn: () => api.products(q || undefined) });

  const columns = useMemo(
    () => [
      col.accessor('name', { header: t('products.name') }),
      col.accessor('sku', { header: t('products.sku'), cell: (c) => <span className="ltr">{c.getValue()}</span> }),
      col.accessor('variants', { header: t('products.variants'), cell: (c) => c.getValue().join(', '), enableSorting: false }),
      col.accessor('price', { header: t('products.price'), cell: (c) => <span className="ltr">{formatDZD(c.getValue(), lang)}</span>, meta: { n: true } }),
      col.accessor('cost', { header: t('products.cost'), cell: (c) => <span className="ltr">{formatDZD(c.getValue(), lang)}</span>, meta: { n: true } }),
      col.accessor('stock', {
        header: t('products.stock'),
        meta: { n: true },
        cell: (c) => (
          <span className="ltr">
            {c.getValue() <= LOW_STOCK && <span className="flag">{t('products.lowStock')}</span>} {c.getValue()}
          </span>
        ),
      }),
    ],
    [t, lang],
  );

  const table = useReactTable({ data: query.data ?? [], columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  return (
    <>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('products.name')} />
      {query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorBox onRetry={() => query.refetch()} />
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      className={(h.column.columnDef.meta as { n?: boolean } | undefined)?.n ? 'n' : ''}
                      onClick={h.column.getToggleSortingHandler()}
                      style={{ cursor: h.column.getCanSort() ? 'pointer' : 'default' }}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((r) => (
                <tr key={r.id}>
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className={(c.column.columnDef.meta as { n?: boolean } | undefined)?.n ? 'n' : ''}>
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
