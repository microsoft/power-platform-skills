import { makeStyles, tokens } from '@fluentui/react-components';
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Ready', count: 3 }, { name: 'Waiting', count: 2 }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}>{rows.map((row) => <p key={row.name}>{row.name}: {row.count}</p>)}</div>;
};
export default GeneratedComponent;
