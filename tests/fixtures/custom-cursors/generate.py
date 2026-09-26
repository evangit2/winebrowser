from pathlib import Path
import struct
root=Path(__file__).parent

def image(bits,size,kind,hot=(3,5)):
    count=2**bits if bits<=8 else 0
    palette=[]
    for i in range(count):
        if not i:color=(0,0,0)
        elif bits==1:color=(255,255,255)
        elif bits==4:color=[(255,0,0),(0,255,0),(0,0,255)][(i-1)%3]
        else:color=(i,255-i,(3*i)%256)
        palette.append(color)
    stride=((size*bits+31)//32)*4;maskstride=((size+31)//32)*4
    xor=bytearray(stride*size);mask=bytearray(maskstride*size)
    for y in range(size):
      for x in range(size):
        transparent=kind=='blank' or x==0 or y==0
        if bits<=8:
            value=0 if transparent else ((x//8+y//8)%2 if bits==1 else (x//8+y//8)%3+1 if bits==4 else (x+3*y)%255+1)
            shift=8-bits-((x*bits)%8)
            xor[(size-1-y)*stride+(x*bits)//8]|=value<<shift
        else:
            color=(0,0,0) if transparent else ((255,0,0) if kind=='red' else (0,0,255) if kind=='blue' else ((x*7)%256,(y*5)%256,((x+y)*3)%256) if bits==24 else (255,0,0) if x<size//2 else (0,255,0))
            at=(size-1-y)*stride+x*(bits//8)
            xor[at:at+3]=bytes(reversed(color))
            if bits==32:xor[at+3]=0 if transparent else 128 if x<size//2 else 255
        if transparent:mask[(size-1-y)*maskstride+x//8]|=0x80>>(x%8)
    header=struct.pack('<IiiHHIIiiII',40,size,size*2,1,bits,0,len(xor),0,0,count,count)
    data=header+b''.join(bytes((b,g,r,0)) for r,g,b in palette)+xor+mask
    return size,hot,data,count

def cursor(name,images):
    offset=6+16*len(images);entries=[];payload=[]
    for size,hot,data,count in images:
        entries.append(struct.pack('<BBBBHHII',size%256,size%256,count%256,0,*hot,len(data),offset));offset+=len(data);payload.append(data)
    (root/name).write_bytes(struct.pack('<HHH',0,2,len(images))+b''.join(entries)+b''.join(payload))
for bits,name in [(1,'mono'),(4,'four'),(8,'eight'),(24,'truecolor'),(32,'alpha')]:cursor(name+'.cur',[image(bits,32,name)])
cursor('blank.cur',[image(1,32,'blank',(0,0))])
cursor('multi.cur',[image(32,16,'red',(1,2)),image(4,32,'four',(5,7)),image(32,64,'blue',(8,12))])
cursor('small.cur',[image(4,16,'four',(2,3))])
