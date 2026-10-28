// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "opportunity": opportunity,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "opportunity-statecode": opportunity_statecode,
    "opportunity-statuscode": opportunity_statuscode,
}
export type opportunity = TableRow<{
    // Primary Key Column
    readonly opportunityid: string,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    _customerid_value: `/account(${string})` | `/contact(${string})`,
    readonly customeridname: string,
    readonly customeridyominame: string,
    description: string,
    estimatedclosedate: Date,
    estimatedvalue: number,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    name: string,
    _parentaccountid_value: `/account(${string})`,
    readonly parentaccountidname: string,
    readonly parentaccountidyominame: string,
    _parentcontactid_value: `/contact(${string})`,
    readonly parentcontactidname: string,
    readonly parentcontactidyominame: string,
    statecode: opportunity_statecode,
    statuscode: opportunity_statuscode,
}>

const enum opportunity_statecode {
"Open" = 0,
"Won" = 1,
"Lost" = 2,
}
const enum opportunity_statuscode {
"In Progress" = 1,
"On Hold" = 2,
"Won" = 3,
"Canceled" = 4,
"Out-Sold" = 5,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
    pageInput?: PageInput;
}
