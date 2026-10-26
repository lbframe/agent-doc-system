use engine::Engine;
use foo_bar::Thing;

mod logging;

fn main() {
    let _engine = Engine::start();
    logging::init();
    let _thing = foo_bar::Thing::name();
}
