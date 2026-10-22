import * as React from 'react';
import { Button, makeStyles, tokens } from '@fluentui/react-components';

type Request = { name: string; parameters?: Record<string, unknown>; boundTo?: { entityName: string; id: string } };
type Result = { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string } };
type ActionApi = { executeAction?(request: Request): Promise<Result>; executeFunction?(request: Request): Promise<Result> };
type Pending = { current: boolean };
type Setter = (value: string) => void;
type Props = { dataApi: ActionApi; pageInput?: { recordId?: string } };
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const rows = [{ name: 'Approve', kind: 'Action' }, { name: 'Summary', kind: 'Function' }];

async function approveOrder(api: ActionApi, recordId: string, amount: number, pending: Pending, setError: Setter, setStatus: Setter, setIsSubmitting: (value: boolean) => void) {
  if (typeof api.executeAction !== 'function') return;
  if (pending.current || !recordId) return;
  pending.current = true;
  setIsSubmitting(true);
  try {
    const res = await api.executeAction({
      name: 'cnt_ApproveOrder',
      parameters: { Comment: 'Approved', Amount: amount },
      boundTo: { entityName: 'salesorder', id: recordId },
    });
    if (res.indeterminate) { setError('Refresh before retrying; the server may have committed.'); return; }
    if (!res.ok) { setError(res.error?.message ?? 'Action failed.'); return; }
    setStatus(String(res.outputs?.NewStatus ?? ''));
  } catch { setError('Network failed. Try again manually.'); }
  finally { pending.current = false; setIsSubmitting(false); }
}

async function readSummary(api: ActionApi, recordId: string, setError: Setter, setTotal: Setter) {
  if (typeof api.executeFunction !== 'function') return;
  if (!recordId) return;
  const res = await api.executeFunction({ name: 'cnt_GetOrderSummary', parameters: { OrderId: recordId } });
  if (!res.ok) { setError(res.error?.message ?? 'Summary failed.'); return; }
  setTotal(String(res.outputs?.Total ?? ''));
}

const GeneratedComponent = (props: Props) => {
  const { dataApi, pageInput } = props;
  const recordId = pageInput?.recordId ?? '';
  const pending = React.useRef(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [total, setTotal] = React.useState('');
  const styles = useStyles();
  return <div className={styles.root}>
    <p>{rows.map((row) => row.name).join(' / ')}</p>
    <Button disabled={isSubmitting || !recordId || typeof dataApi.executeAction !== 'function'} onClick={() => void approveOrder(dataApi, recordId, 100, pending, setError, setStatus, setIsSubmitting)}>Approve</Button>
    <Button disabled={!recordId || typeof dataApi.executeFunction !== 'function'} onClick={() => void readSummary(dataApi, recordId, setError, setTotal)}>Summary</Button>
    {error && <p role="alert">{error}</p>}<p>{status} {total}</p>
  </div>;
};
export default GeneratedComponent;
