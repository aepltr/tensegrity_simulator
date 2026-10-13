export interface Materials{
    id : string;
    name : string;
    density : number;
    youngsModulus : number;
    yieldStrength : number;
    use : "strut"|"cable"| "both";
    note : string;
}

export const MATERIALS: Materials[] = [
    {
        id: "al-6061-t6",
        name : "ALuminium 6061_T6",
        density : 2700,
        youngsModulus : 68.9e9, //Pa
        yieldStrength : 276e6, //Pa
        use : "strut",
        note: "baseline, general and default choice",
    },
    {
    id: "dyneema-sk78",
    name: "Dyneema SK78",
    density: 970,
    youngsModulus: 110e9,
    yieldStrength: 3000e6,
    use: "cable",
    note: "Lowest density. Creeps under sustained load.",
  },
  {
    id: "vectran-ht",
    name: "Vectran HT",
    density: 1400,
    youngsModulus: 75e9,
    yieldStrength: 3200e6,
    use: "cable",
    note: "Low creep — better for sustained prestress.",
  },
  {
    id: "steel-304",
    name: "Stainless steel 304",
    density: 8000,
    youngsModulus: 193e9,
    yieldStrength: 215e6,
    use: "both",
    note: "Heavy baseline for comparison.",
  },
];

export function materialsFor(use: "strut" | "cable" ) : Materials[] {
    return MATERIALS.filter((m)=> m.use === use || m.use === "both");
}

export function getMaterialById(id : string): Materials | undefined{
    return MATERIALS.find((m)=> m.id ===id);
}


export type CrossSection = 
| {kind: "solidCircle"; diameter : number}
| {kind: "hollowCircle"; outerDiameter: number; wallThickness: number}
| {kind: "solidSquare"; side: number}
| {kind: "hollowSquare"; side : number, wallThickness : number}
| {kind: "rectangle"; width : number; height : number}
| {kind: "triangle"; side:number};



export function CrossSectionArea(section : CrossSection): number{
    switch (section.kind){
        case"solidCircle" : { 
            const r = section.diameter /2;
            return Math.PI * r * r;
        }
        case "hollowCircle":{
            const rOuter = section.outerDiameter/2;
            const rInner = rOuter - section.wallThickness;
            if (rInner < 0) {
                throw Error ("wall thickenss exceeds outer raidus - change it")
            }
            return Math.PI * (rOuter * rOuter - rInner * rInner);
        } 
        case "solidSquare":{
            return section.side * section.side;
        }
        case "hollowSquare":{
            const outerSide = section.side;
            const innerSide = outerSide - 2 * section.wallThickness;
            if (innerSide <0){
                throw Error ("wall thickness exceends the outer part- change it")
            }
            return outerSide * outerSide - innerSide * innerSide;
        }
        case "rectangle":{
            return section.width * section.height;
        }
        case "triangle" : {
            return Math.sqrt(3 * section.side)/4;
        }
        default : {
            const _exhaustive : never = section;
            return _exhaustive;
        }
       
    }
}

export function sizeCable( 
    tension : number, 
    material : Materials,
    safetyFactor = 2.0, 
    minDiameter = 0.001,
): CrossSection {
    const area = (Math.max(0, tension)* safetyFactor)/material.yieldStrength;
    const diameter = Math.max(minDiameter, 2 * Math.sqrt(area / Math.PI));
    return {kind : "solidCircle", diameter};
}


export function barMass(
    length : number,
    material: Materials,
    section : CrossSection,
) : number {
    const area = CrossSectionArea(section);
    return length * area * material.density;
}

export function secondMomentOfArea(section:CrossSection) : number {
   switch (section.kind){
    case "solidCircle" : {
        const r = section.diameter/2;
        return (Math.PI * r ** 4 ) /4;
    }
    case "hollowCircle" : {
        const rOuter = section.outerDiameter/2;
        const rInner = rOuter - section.wallThickness;
        if (rInner <0) {
            throw new Error ("wall thickness exceeds outer radius, change it")
        }
        return (Math.PI*(rOuter ** 4 - rInner ** 4)) /4;
        }
        case "solidSquare" :{
            return (section.side ** 4)/12;
        }
        case "hollowSquare":{
            const outerSide = section.side;
            const innerSide = outerSide - 2 * section.wallThickness;
            if (innerSide <0){
                throw new Error("wall thickness exceeds outer radius, change it");
            }
            return (outerSide ** 4 - innerSide ** 4)/12;
        }
        case "triangle": {
            return ((section.side ** 4) *  Math.sqrt(3))/96
        }
        case "rectangle": {
            const { width: b, height: h } = section;
            return Math.min(b * h ** 3, h * b ** 3) / 12;   // weak axis
        }
        default : {
            const _exhaustive : never = section;
            return _exhaustive;
        }
    }
   }


export function bucklingForce(
    length : number,
    material : Materials,
    section : CrossSection,
    K : number = 1.0
) : number {
    const E = material.youngsModulus;
    const I = secondMomentOfArea(section);
    return (Math.PI * Math.PI * E * I)/Math.pow(K* length, 2);

}


export type FieldSpec = {key : string; label : string; default : number};
export const SECTION_FIELDS : Record < CrossSection ["kind"], FieldSpec[]> ={
    solidCircle :  [ { key : "diameter", label: "diameter (m)", default : 0.02}],
    hollowCircle : [
        {key : "outerDiameter", label: "outer diameter (m)", default : 0.02},
        {key : "wallThickness", label: "wall Thickness (m)", default : 0.002}
    ],
    solidSquare : [{key : "side", label: "side (m)", default : 0.02}],
    hollowSquare :[ 
        {key : "side", label: "side (m)", default : 0.02},
        {key : "wallThickness", label: "wall Thickness (m)", default : 0.002}
    ],
    triangle : [{key : "side", label: "side (m)", default : 0.02}],
    rectangle : [
        {key : "width", label: "width (m)", default : 0.02},
        {key : "height", label: "height (m)", default : 0.04}
    ],
}