import { IInputs, IOutputs } from "./generated/ManifestTypes";
import "./css/StarRating.css";

export class StarRating implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container: HTMLDivElement | null = null;
    private input: HTMLInputElement | null = null;
    private message: HTMLDivElement | null = null;
    private notifyOutputChanged: (() => void) | null = null;
    private value = "";
    private readonly onInput = (): void => {
        if (!this.input) return;
        const next = this.input.value;
        if (next === this.value) return;
        this.value = next;
        this.notifyOutputChanged?.();
    };

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement,
    ): void {
        this.container = container;
        this.notifyOutputChanged = notifyOutputChanged;

        // Field controls must opt in before they can react to allocatedWidth/allocatedHeight changes.
        // See: https://learn.microsoft.com/power-apps/developer/component-framework/reference/mode/trackcontainerresize
        context.mode.trackContainerResize(true);

        const root = document.createElement("div");
        root.className = "starrating-control";

        this.input = document.createElement("input");
        this.input.className = "starrating-input";
        this.input.type = "text";
        this.input.setAttribute("aria-label", "StarRating");
        this.input.addEventListener("input", this.onInput);

        this.message = document.createElement("div");
        this.message.className = "starrating-message";
        this.message.hidden = true;

        root.append(this.input, this.message);
        container.append(root);
        this.updateView(context);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const parameter = context.parameters.sampleProperty;
        const readable = parameter?.security?.readable ?? true;
        const editable = parameter?.security?.editable ?? true;
        const next = parameter?.raw == null ? "" : String(parameter.raw);
        this.value = next;

        if (!this.input || !this.message) return;
        this.input.value = next;
        this.input.disabled = context.mode.isControlDisabled || !readable;
        this.input.readOnly = !editable;
        this.input.hidden = !readable;
        this.message.hidden = readable;
        this.message.textContent = readable ? "" : "You do not have permission to read this value.";
    }

    public getOutputs(): IOutputs {
        return {
            sampleProperty: this.value,
        };
    }

    public destroy(): void {
        if (this.input) {
            this.input.removeEventListener("input", this.onInput);
        }
        this.container?.replaceChildren();
        this.input = null;
        this.message = null;
        this.container = null;
        this.notifyOutputChanged = null;
    }
}
