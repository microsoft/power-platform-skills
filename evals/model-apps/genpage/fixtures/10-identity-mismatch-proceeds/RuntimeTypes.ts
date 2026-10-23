// ---------------- Type Definitions which can be imported from ./RuntimeTypes -------------------------
export interface TableRegistrations extends BaseTableRegistrations {
    "cr_widget": cr_widget,
}
export interface EnumRegistrations extends BaseEnumRegistrations {
    "cr_widget-statecode": cr_widget_statecode,
    "cr_widget-statuscode": cr_widget_statuscode,
}
export type cr_widget = TableRow<{
    // Primary Key Column
    readonly cr_widgetid: string,
    cr_name: string,
    cr_quantity: number,
    cr_sku: string,
    readonly createdbyname: string,
    readonly createdbyyominame: string,
    readonly createdonbehalfbyname: string,
    readonly createdonbehalfbyyominame: string,
    readonly modifiedbyname: string,
    readonly modifiedbyyominame: string,
    readonly modifiedonbehalfbyname: string,
    readonly modifiedonbehalfbyyominame: string,
    readonly owningbusinessunitname: string,
    statecode: cr_widget_statecode,
    statuscode: cr_widget_statuscode,
}>

const enum cr_widget_statecode {
"Active" = 0,
"Inactive" = 1,
}
const enum cr_widget_statuscode {
"Active" = 1,
"Inactive" = 2,
}

export interface UxAgentDataApi extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> {}

export interface GeneratedComponentProps {
    dataApi: UxAgentDataApi;
}
