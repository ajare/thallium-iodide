# Thallium Iodide

Thallium Iodide gives its operator visibility into the resources supporting local AI and a way to recover them manually.

## Language

**Managed resource**:
An explicitly selected container supporting local AI whose condition the operator monitors and whose lifecycle they may control.
_Avoid_: Thing, process, service (when referring to a managed container)

**Managed container**:
An explicitly selected container supporting local AI, including one that has not yet been created.

**Lifecycle state**:
Whether a managed container exists and is running, stopped, or in another container-runtime state.
_Avoid_: Health (when referring only to whether a container is running)

**Readiness**:
Whether a managed resource can respond successfully to its configured application check, independently of its lifecycle state.
_Avoid_: Running (when referring to application responsiveness)

**Lifecycle script**:
An operator-supplied script that creates or destroys a managed container, rather than starting or stopping an existing one.
_Avoid_: Arbitrary command

**Creation**:
Provisioning a missing managed container, distinct from starting an existing stopped container.
_Avoid_: Start (when referring specifically to provisioning)

**Destruction**:
Removing a managed container, distinct from stopping it while retaining its runtime definition.
_Avoid_: Stop (when referring specifically to removal)

**Event timeline**:
A parsed view of a tailed JSONL session log, plotted left-to-right on a graph with time on the X axis and regenerated on every tail chunk. Events sit on two lanes: inference turns and tool calls.
_Avoid_: Transcript, conversation view
