// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "cr_ticket": cr_ticket,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "cr_ticket-cr_priority": cr_ticket_cr_priority,
    "cr_ticket-cr_status": cr_ticket_cr_status,
    "cr_ticket-statecode": cr_ticket_statecode,
    "cr_ticket-statuscode": cr_ticket_statuscode,
}
export type cr_ticket = TableRow<{
    // Primary Key Column
    readonly cr_ticketid: string,
    cr_duedate: Date,
    cr_name: string,
    cr_priority: cr_ticket_cr_priority,
    cr_status: cr_ticket_cr_status,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_ticket_statecode,
    statuscode: cr_ticket_statuscode,
}>

const enum cr_ticket_cr_priority {
"Low" = 100000000,
"Medium" = 100000001,
"High" = 100000002,
"Critical" = 100000003,
}
const enum cr_ticket_cr_status {
"Open" = 100000000,
"In Progress" = 100000001,
"Resolved" = 100000002,
"Closed" = 100000003,
}
const enum cr_ticket_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_ticket_statuscode {
"Active" = 1,
"Inactive" = 2,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}

