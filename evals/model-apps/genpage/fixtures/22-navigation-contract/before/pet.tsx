import { Button, makeStyles, tokens } from '@fluentui/react-components';

declare const Xrm: { Navigation?: { navigateTo?(input: Record<string, unknown>): Promise<void> } };
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Milo' }, { name: 'Luna' }];
const base = { pageId: 'inert-early-value' };
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });

function openGallery() {
  // A Unicode paragraph separator ends this comment.   void Xrm.Navigation?.navigateTo?.({
    ...base, pageType: "generative", /* keep pageId and pageType comments unchanged */ pageId: "PAGEREF_pet-gallery",
  });
}

const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}><p>{rows[0].name}</p><Button onClick={openGallery}>Gallery</Button></div>;
};
export default GeneratedComponent;
