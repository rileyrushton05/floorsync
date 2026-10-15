"use client";

import { ArrowPathIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSection, MenuSeparator } from "@/components/ui/menu";
import { panelTitle, type Workspace } from "./workspace";

/**
 * The topbar menu for a screen's panels: which are shown (hidden ones come
 * back here, in the place they left) and a way back to the default layout.
 */
export function PanelsMenu({ workspace }: { workspace: Workspace }) {
    const { definition, layout } = workspace;
    const ids = Object.keys(definition.panels);
    const shown = new Set(ids.filter((id) => !layout.hidden.includes(id)));

    return (
        <Menu>
            <Button intent="plain" size="sm" aria-label="Panels">
                <Squares2X2Icon />
                <span className="hidden sm:inline">Panels</span>
            </Button>
            <MenuContent placement="bottom end" className="min-w-60">
                <MenuSection
                    title="Show panels"
                    selectionMode="multiple"
                    selectedKeys={shown}
                    shouldCloseOnSelect={false}
                    onSelectionChange={(keys) => {
                        for (const id of ids) {
                            const show = keys === "all" || keys.has(id);
                            if (show !== shown.has(id)) workspace.setHidden(id, !show);
                        }
                    }}
                >
                    {ids.map((id) => (
                        <MenuItem key={id} id={id} textValue={panelTitle(definition, id)}>
                            <MenuLabel>{panelTitle(definition, id)}</MenuLabel>
                        </MenuItem>
                    ))}
                </MenuSection>
                <MenuSeparator />
                <MenuSection>
                    <MenuItem id="reset" isDisabled={workspace.isDefault} onAction={workspace.reset}>
                        <ArrowPathIcon />
                        <MenuLabel>Reset layout</MenuLabel>
                    </MenuItem>
                </MenuSection>
            </MenuContent>
        </Menu>
    );
}
