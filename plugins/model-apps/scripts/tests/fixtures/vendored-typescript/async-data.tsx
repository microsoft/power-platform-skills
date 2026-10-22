import * as React from 'react';
import { Spinner, Table, TableBody, TableCell, TableRow } from '@fluentui/react-components';
import type { GeneratedComponentProps, TableRow as Row } from './RuntimeTypes';

interface Item { id: string; name?: string | null; }

async function loadItems(props: GeneratedComponentProps): Promise<Item[]> {
  const result = await props.dataApi.queryTable('lvt_ticket', { select: ['lvt_ticketid', 'lvt_name'], top: 25 });
  return result.rows.map((r: Row<'lvt_ticket'>) => ({ id: String(r.lvt_ticketid), name: r.lvt_name ?? null }));
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const [items, setItems] = React.useState<Item[] | undefined>();
  React.useEffect(() => {
    let cancelled = false;
    loadItems(props).then((rows) => { if (!cancelled) setItems(rows); }).catch(() => setItems([]));
    return () => { cancelled = true; };
  }, [props]);
  if (!items) return <Spinner label="Loading" />;
  return (
    <Table>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id}><TableCell>{item.name?.trim() || '(no name)'}</TableCell></TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export default GeneratedComponent;