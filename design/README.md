# Design

This folder contains the design artefacts and rationale for the FloorSync manager dashboard. It demonstrates how the team understood user needs, explored solutions, and iterated on the interface based on user feedback and usability heuristics.

## What is Included

### `01_inspiration/`
Contains reference images from existing industry tools (Freshdesk, Qual, and Asana) that informed our UI choices. These were used to apply Jakob's Law, ensuring our custom design felt familiar to users who have used other scheduling or dashboard software.

### `02_wireframes/`
Contains the initial low-fidelity wireframes for the core manager views (Overview, Simulation, and Machines). These established the layout and information architecture before any code was written. 

### `03_ui-evolution/`
This folder is critical evidence of our iterative design process. It is split into two stages to clearly demonstrate how user testing and technical constraints forced us to re-evaluate our approach:
- **`01_first-implementation/`**: The initial coded versions based on the wireframes.
- **`02_mid-stage/`**: The versions that were tested and revealed UX flaws (e.g., clunky schedule selection, unreadable timeline blocks).

*(Note: The final polished implementations of these fixes—such as the Timeline Zoom Bar, Expand/Collapse controls, and sidebar layouts—are demonstrated in the live prototype and the main project repository).*

## Design Rationale & Usability Heuristics

Our design decisions were guided by established usability heuristics and industry references, which directly informed the implementation:

1. **Jakob's Law (Familiarity):** Users are already familiar with color-coded Gantt charts from tools like Freshdesk. We borrowed this familiar layout for our schedule timeline (tickets #203, #207) to make the custom system immediately intuitive.
2. **Nielsen's Heuristic: Aesthetic & Minimalist Design:** To reduce cognitive load, we implemented a clean side-navigation bar and structured KPI layouts on the manager overview page (inspired by the Asana reference), keeping the screen uncluttered.
3. **Nielsen's Heuristic: Recognition rather than Recall:** We implemented search and filter functions on the Jobs and Machines pages (inspired by the Qual reference). This ensures users can find specific jobs/machines without having to memorize their exact names or locations (tickets #218, #242, #243).

## Design Iterations Driven by User Feedback

The progression shown in `03_ui-evolution/` reflects direct responses to user testing and self-identified UX issues:
- **Simulation/Schedules:** Users noted that schedule blocks were too small to read in a 24-hour view, and scrolling through 100+ jobs was tedious. This led to the implementation of the **Timeline Zoom Bar** and **Expand/Collapse controls**.
- **Simulation Page:** Early designs for schedule selection felt clunky. Based on user feedback, we pivoted to a sidebar layout to provide a familiar way to view multiple confirmed schedules.
- **Loading States:** Users could not tell how long a schedule took to generate. We added a **Loading Bar & Time Estimation** feature to provide continuous feedback during plan generation.

## External Design Tools
Design work was primarily conducted using **Adobe Photoshop**. The flat exported images used for handoff and implementation are stored in `02_wireframes/` and `03_ui-evolution/`.