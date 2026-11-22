import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Texture, Mesh } from 'three';
import { createPhoneScene, phoneDisplayLayout } from './t3/phoneScene';
import { createAndroidFoldScene } from './t3/androidFoldScene';
import { shapeFor } from './T3DeviceView';
import { resolveDeviceProfile } from './deviceProfile';
import { resolveDeviceModelId } from './t3/model';
import type { MobilePhone3DProps } from './MobilePhone3D';

function props(name: string): MobilePhone3DProps {
  return { deviceModel: name, profile: resolveDeviceProfile('android','',name), children:null,is3D:true,rotX:0,rotY:0,onRotate:()=>{},onResetView:()=>{} };
}
function camera() { const c=new PerspectiveCamera(32,1,.1,30);c.position.z=5.5;c.updateProjectionMatrix();c.updateMatrixWorld();return c; }
describe('T3 device presentation integration', () => {
  it('uses different Google and Samsung camera geometry', () => {
    const pixel=shapeFor(props('Pixel 10 Pro'),.45);
    const samsung=shapeFor(props('Samsung Galaxy S26 Ultra'),.45);
    expect(pixel.camera.width).toBeGreaterThan(pixel.camera.height);
    expect(samsung.camera.height).toBeGreaterThan(samsung.camera.width);
    expect(pixel.brand).toBe('google');expect(samsung.brand).toBe('samsung');
  });
  it('creates a closed solid body and maps its screen center with raycasting', () => {
    const scene=createPhoneScene(new Texture(),phoneDisplayLayout(null,900,1950),shapeFor(props('Pixel 10a'),.45));
    const point=scene.screenPoint(.5,.5,camera());
    expect(point?.x).toBeCloseTo(.5,1);expect(point?.y).toBeCloseTo(.5,1);
    let solids=0;
    scene.root.traverse((object)=>{ if(object instanceof Mesh && object.geometry.type==='ExtrudeGeometry') solids++; });
    expect(solids).toBeGreaterThan(0);
    scene.dispose();
  });
  it('ships no manufacturer model assets', () => {
    for (const name of ['iPhone 18 Pro','iPhone 18 Pro Max','iPhone Duo','iPad Pro 13-inch (M5)']) expect(resolveDeviceModelId('ios',name)).toBeNull();
  });
  it('builds distinct original camera styles per family', () => {
    const count=(name: string, mesh: string, ios=false)=>{
      const p: MobilePhone3DProps={...props(name),isIos:ios,profile:resolveDeviceProfile(ios?'ios':'android','',name)};
      const scene=createPhoneScene(new Texture(),phoneDisplayLayout(null,900,1950),shapeFor(p,.45));
      let n=0; scene.root.traverse((o)=>{ if(o.name===mesh) n++; }); scene.dispose(); return n;
    };
    expect(count('Samsung Galaxy S26','camera-plate')).toBe(0);
    expect(count('Pixel 10','camera-plate')).toBe(1);
    expect(count('iPhone 18 Pro','camera-lens',true)).toBe(3);
    expect(count('iPhone 18','camera-lens',true)).toBe(2);
    expect(count('Xiaomi 15','camera-lens')).toBe(4);
  });
  it('gives the visor the full body width', () => {
    const scene=createPhoneScene(new Texture(),phoneDisplayLayout(null,900,1950),shapeFor(props('Pixel 10'),.45));
    const plate=scene.root.getObjectByName('camera-plate') as Mesh; plate.geometry.computeBoundingBox();
    const box=plate.geometry.boundingBox!; expect(box.max.x-box.min.x).toBeGreaterThan(scene.width*.95);
    scene.dispose();
  });
  it('builds articulated fold panels with finite vertices for both brands', () => {
    for(const name of ['Pixel Fold','Samsung Galaxy Z Fold']) {
      const scene=createAndroidFoldScene(new Texture(),phoneDisplayLayout(null,2076,2152),180,2076/2152,shapeFor(props(name),1));
      expect(scene.root.getObjectByName('rear-camera')).toBeDefined();
      for(const angle of [0,90,180]) {
        scene.setAngle(angle);scene.root.updateMatrixWorld(true);
        scene.root.traverse((object)=>{if(object instanceof Mesh){
          const positions=object.geometry.getAttribute('position');
          expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
          expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true);
        }});
      }
      scene.dispose();
    }
  });
});
