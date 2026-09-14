/**
 * The manager overview has no backend contract yet. Its explicit prototype is
 * isolated from the route-facing screen so replacing it cannot leak fixture
 * state into an API-backed feature.
 */
export { default } from "./fixtures/OverviewPrototype";
