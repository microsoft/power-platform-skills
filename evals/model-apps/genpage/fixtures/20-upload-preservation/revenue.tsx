import { Button, makeStyles, tokens } from '@fluentui/react-components';
import * as React from 'react';
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Services', revenue: 100 }, { name: 'Products', revenue: 80 }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const [descending, setDescending] = React.useState(true);
  const styles = useStyles();
  const sorted = [...rows].sort((a, b) => descending ? b.revenue - a.revenue : a.revenue - b.revenue);
  return <div className={styles.root}><Button onClick={() => setDescending(!descending)}>Sort revenue</Button>{sorted.map((row) => <p key={row.name}>{row.name}: {row.revenue}</p>)}</div>;
};
export default GeneratedComponent;
