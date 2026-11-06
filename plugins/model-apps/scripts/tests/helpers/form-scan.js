'use strict';
// The form scan teardown runs before it deletes a page (lib/page-reference-guard.js): every form, in both layers, read to find a cell that embeds the page.
//   GET /systemforms?$select=formid,objecttypecode,name,type,formxml                                                     the PUBLISHED layer
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml  the SAVED layer
// A stand-in that does not model forms answers both with no rows: no form embeds the page, so the delete goes ahead as it did before the scan.
// The guard fails closed on a refused read, so a stand-in that throws "unexpected read" for these URLs would stop every page delete.
const FORM_SCAN_PATHS = [
  '/systemforms?$select=formid,objecttypecode,name,type,formxml',
  '/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml',
];

const isFormScan = (url) => FORM_SCAN_PATHS.includes(url);
const noFormRows = () => ({ status: 200, headers: {}, body: { value: [] } });

module.exports = { FORM_SCAN_PATHS, isFormScan, noFormRows };