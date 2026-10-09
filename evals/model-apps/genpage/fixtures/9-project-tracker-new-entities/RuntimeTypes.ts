// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "cr_milestone": cr_milestone,
    "cr_project": cr_project,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "cr_milestone-cr_status": cr_milestone_cr_status,
    "cr_milestone-statecode": cr_milestone_statecode,
    "cr_milestone-statuscode": cr_milestone_statuscode,
    "cr_project-cr_status": cr_project_cr_status,
    "cr_project-statecode": cr_project_statecode,
    "cr_project-statuscode": cr_project_statuscode,
}
export type cr_milestone = TableRow<{
    // Primary Key Column
    readonly cr_milestoneid: string,
    _cr_project_value: `/cr_project(${string})`,
    cr_duedate: Date,
    cr_name: string,
    cr_percentcomplete: number,
    readonly cr_projectname: string,
    cr_status: cr_milestone_cr_status,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_milestone_statecode,
    statuscode: cr_milestone_statuscode,
}>
export type cr_project = TableRow<{
    // Primary Key Column
    readonly cr_projectid: string,
    cr_budget: number,
    readonly cr_budget_base: number,
    cr_manager: string,
    cr_name: string,
    cr_startdate: Date,
    cr_status: cr_project_cr_status,
    cr_targetdate: Date,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly exchangerate: number,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_project_statecode,
    statuscode: cr_project_statuscode,
    readonly _transactioncurrencyid_value: `/transactioncurrency(${string})`,
    readonly transactioncurrencyidname: string,
}>

const enum cr_milestone_cr_status {
"Not Started" = 100000000,
"In Progress" = 100000001,
"Completed" = 100000002,
"Blocked" = 100000003,
}
const enum cr_milestone_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_milestone_statuscode {
"Active" = 1,
"Inactive" = 2,
}
const enum cr_project_cr_status {
"Planning" = 100000000,
"Active" = 100000001,
"On Hold" = 100000002,
"Completed" = 100000003,
}
const enum cr_project_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_project_statuscode {
"Active" = 1,
"Inactive" = 2,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}
