# Design

This folder contains the design artefacts and rationale for the FloorSync manager dashboard. It demonstrates how the team understood user needs, explored solutions, and iterated on the interface based on user feedback and usability heuristics.

## What is Included

### Industry references
Existing tools (Freshdesk, Qual and Asana) informed our UI choices. We used them to apply Jakob's Law, so the design would feel familiar to anyone who has used other scheduling or dashboard software. Their screenshots are not included in this repository.

### `02_wireframes/`
Contains the early mockups made before any code was written: the manager overview (`dashboard-manager.png`), the operator dashboard (`dashboard-operator.png`), and the original coordinator view (`dashboard-manager-simulation.png`), whose planning and timeline role later moved into the manager's Planner and Simulation pages when the coordinator and manager became one role. These established the layout and information architecture.

### `03_ui_evolution/`
This folder is critical evidence of our iterative design process. It is split into three stages to clearly demonstrate how user testing and technical constraints forced us to re-evaluate our approach:
- **`01_first-implementation/`**: The initial coded versions based on the wireframes.
- **`02_mid-stage/`**: The versions that were tested and revealed UX flaws (e.g., clunky schedule selection, unreadable timeline blocks).
- **`03_final/`**: The final interface, including fixes described below such as the Timeline Zoom Bar and the sidebar of confirmed schedules, captured with demo data for a glass workshop.

## Design Rationale & Usability Heuristics

Our design decisions were guided by established usability heuristics and industry references, which directly informed the implementation:

1. **Jakob's Law (Familiarity):** Users are already familiar with color-coded Gantt charts from tools like Freshdesk. We borrowed this familiar layout for our schedule timeline (tickets #203, #207) to make the custom system immediately intuitive.
2. **Nielsen's Heuristic: Aesthetic & Minimalist Design:** To reduce cognitive load, we implemented a clean side-navigation bar and structured KPI layouts on the manager overview page (inspired by Asana), keeping the screen uncluttered.
3. **Nielsen's Heuristic: Recognition rather than Recall:** We implemented search and filter functions on the Jobs and Machines pages (inspired by Qual). This ensures users can find specific jobs/machines without having to memorize their exact names or locations (tickets #218, #242, #243).

## Design Iterations Driven by User Feedback

The progression shown in `03_ui_evolution/` reflects direct responses to user testing and self-identified UX issues:
- **Simulation/Schedules:** Users noted that schedule blocks were too small to read in a 24-hour view, and scrolling through 100+ jobs was tedious. This led to the implementation of the **Timeline Zoom Bar** and **Expand/Collapse controls**.
- **Simulation Page:** Early designs for schedule selection felt clunky. Based on user feedback, we pivoted to a sidebar layout to provide a familiar way to view multiple confirmed schedules.
- **Loading States:** Users could not tell how long a schedule took to generate. We added a **Loading Bar & Time Estimation** feature to provide continuous feedback during plan generation.

## External Design Tools
Design work was primarily conducted using **Adobe Photoshop**. The flat exported images used for handoff and implementation are stored in `02_wireframes/`, and screenshots of the built interface in `03_ui_evolution/`.