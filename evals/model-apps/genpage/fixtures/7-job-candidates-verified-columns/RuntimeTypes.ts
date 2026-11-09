// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "cr_candidate": cr_candidate,
    "cr_jobrequisition": cr_jobrequisition,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "cr_candidate-cr_applicationstatus": cr_candidate_cr_applicationstatus,
    "cr_candidate-statecode": cr_candidate_statecode,
    "cr_candidate-statuscode": cr_candidate_statuscode,
    "cr_jobrequisition-statecode": cr_jobrequisition_statecode,
    "cr_jobrequisition-statuscode": cr_jobrequisition_statuscode,
}
export type cr_candidate = TableRow<{
    // Primary Key Column
    readonly cr_candidateid: string,
    _cr_jobrequisition_value: `/cr_jobrequisition(${string})`,
    cr_applicationstatus: cr_candidate_cr_applicationstatus,
    cr_interviewscore: number,
    readonly cr_jobrequisitionname: string,
    cr_name: string,
    cr_recruiter: string,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_candidate_statecode,
    statuscode: cr_candidate_statuscode,
}>
export type cr_jobrequisition = TableRow<{
    // Primary Key Column
    readonly cr_jobrequisitionid: string,
    cr_department: string,
    cr_name: string,
    cr_openings: number,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_jobrequisition_statecode,
    statuscode: cr_jobrequisition_statuscode,
}>

const enum cr_candidate_cr_applicationstatus {
"Applied" = 100000000,
"Screening" = 100000001,
"Interviewing" = 100000002,
"Offer" = 100000003,
"Hired" = 100000004,
"Rejected" = 100000005,
}
const enum cr_candidate_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_candidate_statuscode {
"Active" = 1,
"Inactive" = 2,
}
const enum cr_jobrequisition_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_jobrequisition_statuscode {
"Active" = 1,
"Inactive" = 2,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}
