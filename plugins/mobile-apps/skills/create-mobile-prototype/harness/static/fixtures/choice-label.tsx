import { Text } from 'tamagui';
declare const row: { cr_status: number };
export default function Fixture() { return <Text>{row.cr_status}</Text>; }