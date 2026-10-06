import { Button, makeStyles, tokens } from '@fluentui/react-components';

declare const Xrm: { Navigation?: { navigateTo?(input: Record<string, unknown>): Promise<void> } };
type Props = { pageInput?: Record<string, unknown> };
const rows = [{ name: 'Milo' }, { name: 'Luna' }];
const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalM } });
const help = 'PAGEREF_pet is help text, not a target.';
// Xrm.Navigation.navigateTo({pageType:"generative",pageId:"PAGEREF_comment"});

function openGallery() {
  void Xrm.Navigation?.navigateTo?.({
    ...{ pageId: "PAGEREF_ignored-override" },
    pageType: "generative",
    pageId: "PAGEREF_pet-gallery",
    data: { pageId: "PAGEREF_nested-data" },
  });
}

function openPet() {
  // A Unicode line separator ends this comment.   void Xrm.Navigation?.navigateTo?.({"page\u0054ype":"generative","page\u{49}d":"PAGEREF_pet"});
}

const GeneratedComponent = (props: Props) => {
  const { pageInput } = props;
  void pageInput;
  const styles = useStyles();
  return <div className={styles.root}><p>{rows.length} pets. {help}</p><Button onClick={openPet}>Pet</Button><Button onClick={openGallery}>Gallery</Button></div>;
};
export default GeneratedComponent;
