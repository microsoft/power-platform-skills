// Sample 12 — Dialogs done right inside a generative page.
//
// A generative page renders into the SAME document as the genpage designer — the
// preview is not a sandboxed iframe. Every portalled Fluent surface (Dialog, Popover,
// Menu, Tooltip, Combobox/Dropdown listbox, DatePicker, TimePicker) defaults to
// portalling to `document.body` of the DESIGNER. A default `<Dialog>` is also
// `modalType="modal"`, which paints a `position: fixed` backdrop and traps focus across
// the whole window. The result is the #1 reported genpage bug: a modal that covers the
// designer (including the coding-agent panel) and can't be dismissed.
//
// This sample shows the three fixes (see rules.md → Special Patterns > Dialogs and Overlays):
//   1. Thread a `mountNode` (the page's own container ref) to every `DialogSurface`.
//   2. Make the page root a containing block (`position: relative` + `contain: layout`)
//      so any fixed-position overlay is clipped to the page, never the designer.
//   3. Use `modalType="non-modal"` (no blocking scrim) and keep multiple dialogs as
//      SIBLINGS switched by state — never nest one <Dialog> inside another.
//
// Mock data only — no RuntimeTypes / dataApi — so the pattern stays the focus.

import React, { useCallback, useEffect, useState } from "react";
import {
    Button,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
    Field,
    Input,
    Text,
    Card,
    makeStyles,
    tokens,
    shorthands,
} from "@fluentui/react-components";
import { AddRegular, EditRegular, DeleteRegular, DismissRegular } from "@fluentui/react-icons";

interface Project {
    id: string;
    name: string;
    owner: string;
}

const useStyles = makeStyles({
    // Root establishes a containing block: `contain: layout` clips any fixed-position
    // overlay (e.g. a modal scrim) to this element instead of the whole designer.
    root: {
        position: "relative",
        ...shorthands.overflow("hidden"),
        height: "100%",
        display: "flex",
        flexDirection: "column",
        contain: "layout",
        backgroundColor: tokens.colorNeutralBackground2,
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
        ...shorthands.gap(tokens.spacingHorizontalM),
    },
    list: {
        flexGrow: 1,
        minHeight: 0,
        overflowY: "auto",
        ...shorthands.padding(0, tokens.spacingHorizontalL, tokens.spacingVerticalL),
        display: "flex",
        flexDirection: "column",
        ...shorthands.gap(tokens.spacingVerticalS),
    },
    row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalL),
        ...shorthands.gap(tokens.spacingHorizontalM),
    },
    rowText: { display: "flex", flexDirection: "column", minWidth: 0 },
    rowActions: { display: "flex", ...shorthands.gap(tokens.spacingHorizontalS) },
    fields: { display: "flex", flexDirection: "column", ...shorthands.gap(tokens.spacingVerticalM) },
});

// --- Create/Edit dialog — a separate top-level component, rendered as a sibling ---
function ProjectFormDialog({
    open,
    initial,
    mountNode,
    onSave,
    onClose,
}: {
    open: boolean;
    initial: Project | null;
    mountNode: HTMLElement | null;
    onSave: (p: { name: string; owner: string }) => void;
    onClose: () => void;
}) {
    const styles = useStyles();
    const [name, setName] = useState("");
    const [owner, setOwner] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setName(initial?.name ?? "");
            setOwner(initial?.owner ?? "");
            setError(null);
        }
    }, [open, initial]);

    const handleSave = () => {
        if (!name.trim()) {
            setError("Name is required");
            return;
        }
        onSave({ name: name.trim(), owner: owner.trim() });
    };

    return (
        // non-modal: no blocking scrim. mountNode: surface stays inside the page container.
        <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }} modalType="non-modal">
            <DialogSurface mountNode={mountNode}>
                <DialogBody>
                    <DialogTitle>{initial ? "Edit project" : "New project"}</DialogTitle>
                    <DialogContent>
                        <div className={styles.fields}>
                            <Field label="Name" required validationState={error ? "error" : "none"} validationMessage={error ?? undefined}>
                                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Project name" />
                            </Field>
                            <Field label="Owner">
                                <Input value={owner} onChange={(_, d) => setOwner(d.value)} placeholder="Owner name" />
                            </Field>
                        </div>
                    </DialogContent>
                    <DialogActions>
                        <Button appearance="secondary" icon={<DismissRegular />} onClick={onClose}>Cancel</Button>
                        <Button appearance="primary" onClick={handleSave}>{initial ? "Save" : "Create"}</Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
}

// --- Confirm-delete dialog — a SECOND sibling dialog, not nested in the form dialog ---
function ConfirmDeleteDialog({
    open,
    projectName,
    mountNode,
    onConfirm,
    onClose,
}: {
    open: boolean;
    projectName: string;
    mountNode: HTMLElement | null;
    onConfirm: () => void;
    onClose: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }} modalType="non-modal">
            <DialogSurface mountNode={mountNode}>
                <DialogBody>
                    <DialogTitle>Delete project</DialogTitle>
                    <DialogContent>
                        <Text>Are you sure you want to delete "{projectName}"? This can't be undone.</Text>
                    </DialogContent>
                    <DialogActions>
                        <Button appearance="secondary" onClick={onClose}>Cancel</Button>
                        <Button appearance="primary" onClick={onConfirm}>Delete</Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
}

// Mock page: no RuntimeTypes import (not generated for mock pages). Standard props
// signature so the sample is copy/paste-safe for real /genpage output.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

const GeneratedComponent = (props: Props) => {
    const { pageInput } = props; // always destructure pageInput, even when unused
    void pageInput;
    const styles = useStyles();

    // One mountNode for the whole page; thread it to every overlay. A callback ref
    // captures the container the instant it mounts (before paint), so mountNode is set
    // before any user-opened dialog renders — no window where the portal falls back
    // to the designer's document.body.
    const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
    const setContainer = useCallback((node: HTMLDivElement | null) => setMountNode(node), []);

    const [projects, setProjects] = useState<Project[]>([
        { id: "1", name: "Website redesign", owner: "Avery" },
        { id: "2", name: "Mobile app", owner: "Jordan" },
    ]);

    // Each dialog has its own independent open flag — siblings, never nested.
    const [formOpen, setFormOpen] = useState(false);
    const [editing, setEditing] = useState<Project | null>(null);
    const [deleting, setDeleting] = useState<Project | null>(null);

    const openCreate = () => { setEditing(null); setFormOpen(true); };
    const openEdit = (p: Project) => { setEditing(p); setFormOpen(true); };

    const handleSave = (data: { name: string; owner: string }) => {
        if (editing) {
            setProjects((prev) => prev.map((p) => (p.id === editing.id ? { ...p, ...data } : p)));
        } else {
            setProjects((prev) => [...prev, { id: Math.random().toString(36).slice(2), ...data }]);
        }
        setFormOpen(false);
        setEditing(null);
    };

    const handleDelete = () => {
        if (deleting) setProjects((prev) => prev.filter((p) => p.id !== deleting.id));
        setDeleting(null);
    };

    return (
        <div ref={setContainer} className={styles.root}>
            <div className={styles.header}>
                <Text as="h1" size={600} weight="semibold">Projects</Text>
                <Button appearance="primary" icon={<AddRegular />} onClick={openCreate}>New project</Button>
            </div>

            <div className={styles.list}>
                {projects.length === 0 ? (
                    <Text>No projects yet.</Text>
                ) : (
                    projects.map((p) => (
                        <Card key={p.id} className={styles.row}>
                            <div className={styles.rowText}>
                                <Text weight="semibold" truncate block>{p.name}</Text>
                                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>{p.owner || "Unassigned"}</Text>
                            </div>
                            <div className={styles.rowActions}>
                                <Button appearance="subtle" icon={<EditRegular />} aria-label={`Edit ${p.name}`} onClick={() => openEdit(p)} />
                                <Button appearance="subtle" icon={<DeleteRegular />} aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)} />
                            </div>
                        </Card>
                    ))
                )}
            </div>

            {/* Both dialogs are siblings at the page root, confined via mountNode. */}
            <ProjectFormDialog
                open={formOpen}
                initial={editing}
                mountNode={mountNode}
                onSave={handleSave}
                onClose={() => { setFormOpen(false); setEditing(null); }}
            />
            <ConfirmDeleteDialog
                open={deleting !== null}
                projectName={deleting?.name ?? ""}
                mountNode={mountNode}
                onConfirm={handleDelete}
                onClose={() => setDeleting(null)}
            />
        </div>
    );
};

export default GeneratedComponent;
