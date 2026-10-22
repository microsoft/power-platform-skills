// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "account": account,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "account-accountcategorycode": account_accountcategorycode,
    "account-statecode": account_statecode,
    "account-statuscode": account_statuscode,
}
export type account = TableRow<{
    // Primary Key Column
    readonly accountid: string,
    accountcategorycode: account_accountcategorycode,
    accountnumber: string,
    address1_city: string,
    address1_country: string,
    address1_line1: string,
    address1_postalcode: string,
    address1_stateorprovince: string,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    description: string,
    emailaddress1: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    name: string,
    numberofemployees: number,
    readonly owningbusinessunitname: string,
    _primarycontactid_value: `/contact(${string})`,
    readonly primarycontactidname: string,
    readonly primarycontactidyominame: string,
    revenue: number,
    statecode: account_statecode,
    statuscode: account_statuscode,
    telephone1: string,
    websiteurl: string,
}>

const enum account_accountcategorycode {
"Preferred Customer" = 1,
"Standard" = 2,
}
const enum account_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum account_statuscode {
"Active" = 1,
"Inactive" = 2,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}
