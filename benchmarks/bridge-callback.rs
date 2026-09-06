//! Cheap actual WASM functions for isolating JS memory bridge overhead.
#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    loop {}
}

static mut WIDTH: usize = 2;

#[no_mangle]
pub unsafe extern "C" fn set_width(n: usize) {
    WIDTH = n;
}

#[no_mangle]
pub unsafe extern "C" fn logp(x: *const f64, g: *mut f64) -> f64 {
    let mut value = 0.;
    for i in 0..WIDTH {
        let xi = *x.add(i);
        *g.add(i) = -xi;
        value -= xi * xi / 2.;
    }
    value
}

#[no_mangle]
pub unsafe extern "C" fn expand(x: *const f64, out: *mut f64) -> i32 {
    for i in 0..WIDTH {
        *out.add(i) = 2. * *x.add(i);
    }
    0
}
