import * as BABYLON from "babylonjs";

export interface Topology {
  points: BABYLON.Vector3[];
  struts: [number, number][];
  cables: [number, number][];
}

// Replace strut `strutIdx` with a T-bar unit at opening angle alpha (radians).
export function substituteTBar(
  topo: Topology, strutIdx: number, alpha: number
): Topology {
  const [ia, ib] = topo.struts[strutIdx];
  const A = topo.points[ia], B = topo.points[ib];

  const axis = B.subtract(A);
  const L0 = axis.length();
  const u = axis.scale(1 / L0);
  const mid = A.add(B).scale(0.5);

  const t = (L0 / 2) * Math.tan(alpha);

  // any unit vector perpendicular to u
  const seed = Math.abs(u.y) < 0.9 ? BABYLON.Vector3.Up() : BABYLON.Vector3.Right();
  const v = BABYLON.Vector3.Cross(u, seed).normalize();

  const points = [...topo.points];
  const iMid = points.push(mid) - 1;
  const iP   = points.push(mid.add(v.scale(t))) - 1;
  const iM   = points.push(mid.subtract(v.scale(t))) - 1;

  const struts = topo.struts.filter((_, i) => i !== strutIdx);
  struts.push([ia, iMid], [iMid, ib], [iMid, iP], [iMid, iM]);

  const cables = [...topo.cables];
  cables.push([ia, iP], [iP, ib], [ia, iM], [iM, ib]);

  return { points, struts, cables };
}

export function substituteAll(topo: Topology, alpha: number): Topology {
  let result = topo;
  for (let i = topo.struts.length - 1; i >= 0; i--) {
    result = substituteTBar(result, i, alpha);
  }
  return result;
}