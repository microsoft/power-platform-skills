import * as React from "react";
import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { StarRatingView } from "./StarRatingView";
import "./css/StarRating.css";

export class StarRating implements ComponentFramework.ReactControl<IInputs, IOutputs> {
    private notifyOutputChanged: (() => void) | null = null;
    private value = "";

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
    ): void {
        this.notifyOutputChanged = notifyOutputChanged;

        // Field controls must opt in before they can react to allocatedWidth/allocatedHeight changes.
        // See: https://learn.microsoft.com/power-apps/developer/component-framework/reference/mode/trackcontainerresize
        context.mode.trackContainerResize(true);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
        const parameter = context.parameters.sampleProperty;
        const readable = parameter?.security?.readable ?? true;
        const editable = parameter?.security?.editable ?? true;
        this.value = parameter?.raw == null ? "" : String(parameter.raw);

        return React.createElement(StarRatingView, {
            cssClass: "starrating-control",
            inputClass: "starrating-input",
            messageClass: "starrating-message",
            label: "StarRating",
            value: this.value,
            disabled: context.mode.isControlDisabled || !readable,
            readOnly: !editable,
            hidden: !readable,
            message: readable ? "" : "You do not have permission to read this value.",
            onChange: this.onChange,
        });
    }

    public getOutputs(): IOutputs {
        return {
            sampleProperty: this.value,
        };
    }

    public destroy(): void {
        this.notifyOutputChanged = null;
    }

    private readonly onChange = (next: string): void => {
        if (next === this.value) return;
        this.value = next;
        this.notifyOutputChanged?.();
    };
}
